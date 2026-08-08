import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import importRoutes from "../routes/import.js";
import { clearSoundCloudConfig, getDb, setSoundCloudConfig } from "../db/index.js";
import { setupTestDb, seedTrack, teardownTestDb } from "./setup.js";

type FetchHandler = (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
) => Response | Promise<Response>;

function installFetchMock(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => handler(input, init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function importApp(): Hono {
  const app = new Hono();
  app.route("/api/import", importRoutes);
  return app;
}

describe("playlist import routes", () => {
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.MUSAIC_SECRET_KEY;
    process.env.MUSAIC_SECRET_KEY = "test-import-secret";
    setupTestDb();
  });

  afterEach(() => {
    clearSoundCloudConfig();
    if (previousSecret === undefined) delete process.env.MUSAIC_SECRET_KEY;
    else process.env.MUSAIC_SECRET_KEY = previousSecret;
    teardownTestDb();
  });

  it("imports a Yandex playlist through the sidecar and matches tracks through SoundCloud", async () => {
    setSoundCloudConfig({ clientId: "test-soundcloud-client-id-1234567890", fetchedAt: Date.now() });
    const requests: Array<{ url: string; headers: Headers }> = [];
    const restoreFetch = installFetchMock((input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, headers });
      const parsed = new URL(url);

      if (parsed.pathname === "/health") {
        return new Response(null, { status: 200 });
      }

      if (parsed.pathname === "/yandex/playlist") {
        expect(parsed.searchParams.get("id")).toBe("demo:42");
        expect(headers.get("X-Musaic-Secret")).toBe("test-import-secret");
        return jsonResponse({
          title: "Night Drive",
          tracks: [{
            title: "Signal",
            artist: "North Star",
            album: "Night Drive",
            durationSec: 201,
            coverUrl: "https://img.example.test/signal.jpg",
          }],
        });
      }

      if (parsed.hostname === "api-v2.soundcloud.com" && parsed.pathname === "/search/tracks") {
        expect(parsed.searchParams.get("q")).toBe("North Star Signal");
        return jsonResponse({
          collection: [{
            id: 9001,
            title: "Signal",
            user: { id: 77, username: "North Star" },
            duration: 201000,
            permalink_url: "https://soundcloud.com/north-star/signal",
            artwork_url: "https://img.example.test/signal-large.jpg",
            waveform_url: null,
            streamable: true,
          }],
        });
      }

      throw new Error(`unexpected import request: ${url}`);
    });

    try {
      const response = await importApp().request(
        "/api/import/playlist",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://music.yandex.ru/users/demo/playlists/42" }),
        },
      );
      expect(response.status).toBe(200);
      const body = await response.json() as {
        source: string;
        title: string;
        totalTracks: number;
        matchedCount: number;
        matches: Array<{ confidence: string; matchSource?: string; match?: { id: string } }>;
      };

      expect(body.source).toBe("yandex");
      expect(body.title).toBe("Night Drive");
      expect(body.totalTracks).toBe(1);
      expect(body.matchedCount).toBe(1);
      expect(body.matches[0]).toEqual(expect.objectContaining({
        confidence: "high",
        matchSource: "soundcloud",
        match: expect.objectContaining({ id: "sc_9001" }),
      }));
      expect(getDb().prepare("SELECT source, title, artist, duration, cover_url FROM tracks WHERE id = 'sc_9001'").get())
        .toEqual({
          source: "soundcloud",
          title: "Signal",
          artist: "North Star",
          duration: 201,
          cover_url: "https://img.example.test/signal-t300x300.jpg",
        });
      expect(requests.some((request) => request.url.includes("/yandex/playlist"))).toBe(true);
    } finally {
      restoreFetch();
    }
  });

  it("rejects malformed URLs and empty external playlists", async () => {
    const app = importApp();
    const missing = await app.request("/api/import/playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "url required" });

    const unsupported = await app.request("/api/import/playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/playlist/1" }),
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toEqual({
      error: "Unsupported URL. Currently supported: Yandex Music playlists",
    });

    const restoreFetch = installFetchMock((input) => {
      const parsed = new URL(requestUrl(input));
      if (parsed.pathname === "/health") return new Response(null, { status: 200 });
      if (parsed.pathname === "/yandex/playlist") return jsonResponse({ title: "Empty", tracks: [] });
      throw new Error(`unexpected empty import request: ${parsed.toString()}`);
    });
    try {
      const empty = await app.request("/api/import/playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://music.yandex.ru/users/demo/playlists/42" }),
      });
      expect(empty.status).toBe(404);
      expect(await empty.json()).toEqual({ error: "Playlist is empty" });
    } finally {
      restoreFetch();
    }
  });

  it("saves only existing tracks once when the matched list contains duplicates", async () => {
    const firstTrack = seedTrack({ id: "import-first", title: "First" });
    const secondTrack = seedTrack({ id: "import-second", title: "Second" });

    const response = await importApp().request("/api/import/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Imported Mix",
        trackIds: [firstTrack, firstTrack, "missing-track", secondTrack],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; id: string; trackCount: number };
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^import_[a-f0-9]{16}$/);
    expect(body.trackCount).toBe(2);

    const rows = getDb().prepare(
      "SELECT track_id, position FROM playlist_tracks WHERE playlist_id = $id ORDER BY position",
    ).all({ $id: body.id }) as Array<{ track_id: string; position: number }>;
    expect(rows).toEqual([
      { track_id: firstTrack, position: 0 },
      { track_id: secondTrack, position: 1 },
    ]);
  });

  it("validates save requests before touching the playlist tables", async () => {
    const app = importApp();
    const missingName = await app.request("/api/import/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackIds: ["missing"] }),
    });
    expect(missingName.status).toBe(400);
    expect(await missingName.json()).toEqual({ error: "name required" });

    const missingTracks = await app.request("/api/import/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No Tracks", trackIds: [] }),
    });
    expect(missingTracks.status).toBe(400);
    expect(await missingTracks.json()).toEqual({ error: "trackIds required" });
  });
});
