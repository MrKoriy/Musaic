import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { app } from "../index.js";
import soundcloudRoutes from "../routes/soundcloud.js";
import { clearSoundCloudConfig, getDb, setSoundCloudConfig } from "../db/index.js";
import { SoundCloudProvider } from "../providers/soundcloud.js";
import { setupTestDb, teardownTestDb } from "./setup.js";

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

function providerApp(): Hono {
  const routerApp = new Hono();
  routerApp.route("/api/sc", soundcloudRoutes);
  return routerApp;
}

function seedClientId(): void {
  setSoundCloudConfig({ clientId: "client-id-for-tests-1234567890", fetchedAt: Date.now() });
}

describe("SoundCloud provider and routes", () => {
  beforeEach(setupTestDb);

  afterEach(() => {
    clearSoundCloudConfig();
    teardownTestDb();
  });

  it("filters preview tracks and maps full search results into cached tracks", async () => {
    seedClientId();
    const restoreFetch = installFetchMock((input) => {
      const url = requestUrl(input);
      expect(new URL(url).pathname).toBe("/search/tracks");
      return jsonResponse({
        collection: [
          {
            id: 101,
            title: "Signal",
            user: { id: 9, username: "northstar" },
            duration: 120000,
            permalink_url: "https://soundcloud.com/northstar/signal",
            artwork_url: "https://img.example.test/art-large.jpg",
            waveform_url: "https://wave.example.test/101.json",
            genre: "Electronic",
            tag_list: 'chill "late night" electronic',
            bpm: 124,
            streamable: true,
            publisher_metadata: { artist: "North Star", album_title: "Night Drive" },
          },
          {
            id: 102,
            title: "Preview Only",
            user: { id: 9, username: "northstar" },
            duration: 30000,
            permalink_url: "https://soundcloud.com/northstar/preview",
            artwork_url: null,
            waveform_url: null,
            streamable: true,
          },
          {
            id: 103,
            title: "Unavailable",
            user: { id: 9, username: "northstar" },
            duration: 120000,
            permalink_url: "https://soundcloud.com/northstar/unavailable",
            artwork_url: null,
            waveform_url: null,
            streamable: false,
          },
        ],
      });
    });

    try {
      const response = await providerApp().request("/api/sc/search?q=signal");
      expect(response.status).toBe(200);
      const body = await response.json() as { tracks: Array<Record<string, unknown>> };
      expect(body.tracks).toHaveLength(1);
      expect(body.tracks[0]).toEqual(expect.objectContaining({
        id: "sc_101",
        source: "soundcloud",
        title: "Signal",
        artist: "North Star",
        album: "Night Drive",
        duration: 120,
        coverUrl: "https://img.example.test/art-t300x300.jpg",
        waveformUrl: "https://wave.example.test/101.json",
        genre: "Electronic, chill, late night",
      }));
      expect((body.tracks[0]!.metadata as Record<string, unknown>).scId).toBe(101);

      const cached = getDb().prepare(
        "SELECT source, title, artist, duration, waveform_url FROM tracks WHERE id = $id",
      ).get({ $id: "sc_101" });
      expect(cached).toEqual({
        source: "soundcloud",
        title: "Signal",
        artist: "North Star",
        duration: 120,
        waveform_url: "https://wave.example.test/101.json",
      });
    } finally {
      restoreFetch();
    }
  });

  it("prefers a full progressive transcoding over preview and HLS alternatives", async () => {
    seedClientId();
    const requestedURLs: string[] = [];
    const restoreFetch = installFetchMock((input) => {
      const url = requestUrl(input);
      requestedURLs.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === "/tracks/77") {
        return jsonResponse({
          id: 77,
          title: "Signal",
          user: { id: 9, username: "northstar" },
          duration: 120000,
          permalink_url: "https://soundcloud.com/northstar/signal",
          artwork_url: null,
          waveform_url: null,
          streamable: true,
          media: {
            transcodings: [
              { url: "https://cf.example.test/preview/77", format: { protocol: "progressive", mime_type: "audio/mpeg" } },
              { url: "https://cf.example.test/full/77", format: { protocol: "progressive", mime_type: "audio/mpeg" } },
              { url: "https://cf.example.test/hls/77", format: { protocol: "hls", mime_type: "audio/mpeg" } },
            ],
          },
        });
      }
      expect(parsed.pathname).toBe("/full/77");
      return jsonResponse({ url: "https://cdn.example.test/full-signal.mp3" });
    });

    try {
      const provider = new SoundCloudProvider();
      await expect(provider.getStreamUrl("sc_77")).resolves.toBe("https://cdn.example.test/full-signal.mp3");
      expect(requestedURLs).toHaveLength(2);
      expect(requestedURLs[1]).toContain("/full/77");
      expect(requestedURLs[1]).not.toContain("/preview/");
    } finally {
      restoreFetch();
    }
  });

  it("returns validation and auth responses without contacting SoundCloud", async () => {
    const missingQuery = await providerApp().request("/api/sc/search");
    expect(missingQuery.status).toBe(400);
    expect(await missingQuery.json()).toEqual({ error: "q required" });

    seedClientId();
    const status = await providerApp().request("/api/sc/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ clientIdAvailable: true });

    const protectedResponse = await app.request(new Request(
      "http://test.local/api/sc/stream/sc_77",
      { headers: { "x-forwarded-for": "198.51.100.73" } },
    ));
    expect(protectedResponse.status).toBe(401);
    expect(await protectedResponse.json()).toEqual({ error: "Not authenticated" });
  });
});
