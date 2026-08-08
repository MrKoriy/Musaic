import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import smartPlaylistRoutes from "../routes/playlists-smart.js";
import { addTrackToPlaylist, createPlaylist, getDb } from "../db/index.js";
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

function smartApp(userId?: string): Hono {
  const app = new Hono();
  if (userId) {
    app.use("*", async (c, next) => {
      (c as any).set("userId", userId);
      await next();
    });
  }
  app.route("/api/smart-playlists", smartPlaylistRoutes);
  return app;
}

function seedUser(id: string): void {
  getDb().prepare("INSERT INTO users (id, username, password_hash) VALUES ($id, $username, 'test')")
    .run({ $id: id, $username: id });
}

describe("smart playlists", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("generates and saves a rule-based playlist in sorted order", async () => {
    const userId = "smart-rule-user";
    seedUser(userId);
    const high = seedTrack({ id: "rule-high", title: "High", artist: "Rock Artist" });
    const low = seedTrack({ id: "rule-low", title: "Low", artist: "Rock Artist" });
    const excluded = seedTrack({ id: "rule-excluded", title: "Excluded", artist: "Jazz Artist" });
    getDb().exec(`
      UPDATE tracks SET genre = 'Rock', mood = 'Energetic', play_count = 10 WHERE id = 'rule-high';
      UPDATE tracks SET genre = 'Rock', mood = 'Calm', play_count = 3 WHERE id = 'rule-low';
      UPDATE tracks SET genre = 'Jazz', mood = 'Calm', play_count = 99 WHERE id = 'rule-excluded';
    `);

    const response = await smartApp(userId).request("/api/smart-playlists/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Rock Rotation",
        rules: [{ field: "genre", op: "eq", value: "Rock" }],
        sort: "play_count",
        sortDir: "DESC",
        limit: 10,
        save: true,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      playlistId: string;
      count: number;
      tracks: Array<{ id: string; genre: string; play_count: number }>;
    };

    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.tracks.map((track) => track.id)).toEqual([high, low]);
    expect(body.tracks.every((track) => track.genre === "Rock")).toBe(true);
    expect(body.tracks.map((track) => track.play_count)).toEqual([10, 3]);
    expect(getDb().prepare("SELECT name, user_id FROM playlists WHERE id = $id").get({ $id: body.playlistId }))
      .toEqual({ name: "Rock Rotation", user_id: userId });
    expect(getDb().prepare(
      "SELECT track_id, position FROM playlist_tracks WHERE playlist_id = $id ORDER BY position",
    ).all({ $id: body.playlistId })).toEqual([
      { track_id: high, position: 0 },
      { track_id: low, position: 1 },
    ]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM playlist_tracks WHERE track_id = $id").get({ $id: excluded }))
      .toEqual({ n: 0 });
  });

  it("uses the OpenRouter response to create an AI playlist without network access", async () => {
    const userId = "smart-ai-user";
    seedUser(userId);
    const trackId = seedTrack({ id: "ai-track", title: "Blue Hour", artist: "Dreamer" });
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const restoreFetch = installFetchMock((input, init) => {
      const url = requestUrl(input);
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-openrouter-key");
      const requestBody = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
        model: string;
      };
      expect(requestBody.messages.at(-1)?.content).toBe("late night drive");
      expect(requestBody.model.length).toBeGreaterThan(0);
      return jsonResponse({
        choices: [{ message: { content: `["Dreamer - Blue Hour"]` } }],
      });
    });

    try {
      const response = await smartApp(userId).request("/api/smart-playlists/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "late night drive", limit: 1, save: true }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        playlistId: string;
        name: string;
        count: number;
        tracks: Array<{ id: string; title: string; artist: string }>;
      };
      expect(body.ok).toBe(true);
      expect(body.name).toBe("AI: late night drive");
      expect(body.count).toBe(1);
      expect(body.tracks).toEqual([expect.objectContaining({ id: trackId, title: "Blue Hour", artist: "Dreamer" })]);
      expect(getDb().prepare("SELECT user_id, description FROM playlists WHERE id = $id").get({ $id: body.playlistId }))
        .toEqual({ user_id: userId, description: "late night drive" });
      expect(getDb().prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = $id").get({ $id: body.playlistId }))
        .toEqual({ track_id: trackId });
    } finally {
      restoreFetch();
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("imports text lines, returning unmatched entries and saved track rows", async () => {
    const userId = "smart-import-user";
    seedUser(userId);
    const trackId = seedTrack({ id: "text-track", title: "Blue Hour", artist: "Dreamer" });

    const response = await smartApp(userId).request("/api/smart-playlists/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Text Import",
        text: "Dreamer - Blue Hour\nMissing Artist - Missing Song",
        save: true,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      playlistId: string;
      matched: Array<{ input: string; track: { id: string } }>;
      unmatched: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.matched).toEqual([{ input: "Dreamer - Blue Hour", track: expect.objectContaining({ id: trackId }) }]);
    expect(body.unmatched).toEqual(["Missing Artist - Missing Song"]);
    expect(getDb().prepare("SELECT track_id, position FROM playlist_tracks WHERE playlist_id = $id").all({ $id: body.playlistId }))
      .toEqual([{ track_id: trackId, position: 0 }]);
  });

  it("finds tracks shared by multiple playlists", async () => {
    const trackId = seedTrack({ id: "duplicate-track", title: "Shared Song", artist: "Shared Artist" });
    createPlaylist("duplicate-playlist-a", "Playlist A");
    createPlaylist("duplicate-playlist-b", "Playlist B");
    addTrackToPlaylist("duplicate-playlist-a", trackId, 0);
    addTrackToPlaylist("duplicate-playlist-b", trackId, 0);

    const response = await smartApp().request("/api/smart-playlists/duplicates");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      duplicates: Array<{ id: string; playlist_count: number; playlists: string }>;
    };
    expect(body.duplicates).toEqual([expect.objectContaining({
      id: trackId,
      playlist_count: 2,
      playlists: "Playlist A,Playlist B",
    })]);
  });

  it("rejects a blank AI prompt before requiring an API key", async () => {
    const response = await smartApp().request("/api/smart-playlists/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "prompt required" });
  });

  it("allows only the playlist owner to update metadata", async () => {
    const owner = "metadata-owner";
    const other = "metadata-other";
    seedUser(owner);
    seedUser(other);
    createPlaylist("metadata-playlist", "Original", "Original description", owner);

    const missingFields = await smartApp(owner).request("/api/smart-playlists/metadata/metadata-playlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingFields.status).toBe(400);
    expect(await missingFields.json()).toEqual({ error: "name or description required" });

    const forbidden = await smartApp(other).request("/api/smart-playlists/metadata/metadata-playlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hijacked" }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Forbidden" });

    const updated = await smartApp(owner).request("/api/smart-playlists/metadata/metadata-playlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed", description: "Fresh description" }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ ok: true });
    expect(getDb().prepare("SELECT name, description FROM playlists WHERE id = 'metadata-playlist'").get())
      .toEqual({ name: "Renamed", description: "Fresh description" });

    const missing = await smartApp(owner).request("/api/smart-playlists/metadata/no-such-playlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Missing" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Playlist not found" });

    const anonymous = await smartApp().request("/api/smart-playlists/metadata/metadata-playlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "No access" }),
    });
    expect(anonymous.status).toBe(403);
  });
});
