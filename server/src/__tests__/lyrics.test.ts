import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import lyricsRoutes from "../routes/lyrics.js";
import { getDb } from "../db/index.js";
import { getJobStatus, startTranscription } from "../providers/lyrics-pipeline.js";
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

function lyricsApp(): Hono {
  const app = new Hono();
  app.route("/api/lyrics", lyricsRoutes);
  return app;
}

describe("lyrics routes", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("fetches lyrics once, caches them, and serves the cached response", async () => {
    const trackId = seedTrack({
      id: "lyrics-cache-track",
      artist: "North Star",
      title: "Signal",
      duration: 201,
    });
    const lrc = "[00:01.00] First signal\n[00:04.50] Second signal";
    const requests: string[] = [];
    const restoreFetch = installFetchMock((input, init) => {
      const url = requestUrl(input);
      requests.push(url);
      const parsed = new URL(url);
      expect(parsed.hostname).toBe("lrclib.net");
      expect(parsed.pathname).toBe("/api/get");
      expect(parsed.searchParams.get("artist_name")).toBe("North Star");
      expect(parsed.searchParams.get("track_name")).toBe("Signal");
      expect(parsed.searchParams.get("duration")).toBe("201");
      expect(new Headers(init?.headers).get("Lrclib-Client")).toContain("Musaic");
      return jsonResponse({
        id: 1,
        trackName: "Signal",
        artistName: "North Star",
        albumName: "Night Drive",
        duration: 201,
        instrumental: false,
        plainLyrics: "First signal\nSecond signal",
        syncedLyrics: lrc,
      });
    });

    try {
      const first = await lyricsApp().request(`/api/lyrics/${trackId}`);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ trackId, lrc, source: "lrclib", cached: false });
      expect(getDb().prepare("SELECT lrc, source FROM lyrics_cache WHERE track_id = $id").get({ $id: trackId }))
        .toEqual({ lrc, source: "lrclib" });

      const second = await lyricsApp().request(`/api/lyrics/${trackId}`);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ trackId, lrc, source: "lrclib", cached: true });
      expect(requests).toHaveLength(1);
    } finally {
      restoreFetch();
    }
  });

  it("falls back from LRCLIB to Genius plain text and caches the fallback source", async () => {
    const trackId = seedTrack({ id: "lyrics-genius-track", artist: "The Artist", title: "Fallback Song" });
    const previousToken = process.env.GENIUS_ACCESS_TOKEN;
    process.env.GENIUS_ACCESS_TOKEN = "test-genius-token";
    const restoreFetch = installFetchMock((input, init) => {
      const url = requestUrl(input);
      const parsed = new URL(url);

      if (parsed.hostname === "lrclib.net") {
        return new Response(null, { status: 404 });
      }

      if (parsed.hostname === "api.genius.com") {
        expect(parsed.pathname).toBe("/search");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-genius-token");
        return jsonResponse({
          response: {
            hits: [{
              type: "song",
              result: {
                id: 7,
                title: "Fallback Song",
                primary_artist: { name: "The Artist" },
                url: "https://genius.com/the-artist-fallback-song-lyrics",
                path: "/the-artist-fallback-song-lyrics",
              },
            }],
          },
        });
      }

      if (parsed.hostname === "genius.com") {
        return new Response(
          '<div data-lyrics-container="true">[Verse 1]<br>Line &amp; one<br>Line two</div>',
          { headers: { "Content-Type": "text/html" } },
        );
      }

      throw new Error(`unexpected lyrics request: ${url}`);
    });

    try {
      const response = await lyricsApp().request(`/api/lyrics/${trackId}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        trackId,
        lrc: "[Verse 1]\nLine & one\nLine two",
        source: "genius",
        cached: false,
      });
      expect(getDb().prepare("SELECT source FROM lyrics_cache WHERE track_id = $id").get({ $id: trackId }))
        .toEqual({ source: "genius" });
    } finally {
      restoreFetch();
      if (previousToken === undefined) delete process.env.GENIUS_ACCESS_TOKEN;
      else process.env.GENIUS_ACCESS_TOKEN = previousToken;
    }
  });

  it("validates manual lyrics, reports cached job status, and clears the cache", async () => {
    const trackId = seedTrack({ id: "lyrics-manual-track" });
    const app = lyricsApp();
    const headers = { "Content-Type": "application/json" };

    const invalid = await app.request(`/api/lyrics/${trackId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ lrc: "" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "lrc required" });

    const saved = await app.request(`/api/lyrics/${trackId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ lrc: "[00:00.00] Manual line" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, trackId, source: "manual" });

    const done = await app.request(`/api/lyrics/${trackId}/status`);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ trackId, status: "done", cached: true });

    const deleted = await app.request(`/api/lyrics/${trackId}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, trackId });

    const notStarted = await app.request(`/api/lyrics/${trackId}/status`);
    expect(notStarted.status).toBe(200);
    expect(await notStarted.json()).toEqual({ trackId, status: "not_started" });
  });

  it("reports pipeline readiness from configured local or cloud dependencies", async () => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";

    try {
      const response = await lyricsApp().request("/api/lyrics/pipeline/ready");
      expect(response.status).toBe(200);
      const body = await response.json() as { ready: boolean; method?: string };
      expect(body.ready).toBe(true);
      expect(body.method).toBeString();
    } finally {
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("reports an unavailable pipeline and queues no-op prefetches", async () => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    try {
      const ready = await lyricsApp().request("/api/lyrics/pipeline/ready");
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        ready: false,
        error: expect.stringContaining("Install whisper.cpp"),
      });

      const prefetch = await lyricsApp().request("/api/lyrics/prefetch-all", { method: "POST" });
      expect(prefetch.status).toBe(200);
      expect(await prefetch.json()).toEqual({
        ok: true,
        queued: 0,
        message: "All local tracks already have lyrics cached",
      });
    } finally {
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("reports a failed transcription job and rejects unsafe generation targets", async () => {
    const trackId = "pipeline-missing-audio";
    const job = startTranscription(trackId, "/definitely/not/a/real/audio.mp3");
    expect(job).toEqual(expect.objectContaining({ trackId, status: "running" }));

    for (let attempt = 0; attempt < 50; attempt++) {
      if (getJobStatus(trackId)?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(getJobStatus(trackId)).toEqual(expect.objectContaining({
      trackId,
      status: "failed",
      error: "Audio file not found: /definitely/not/a/real/audio.mp3",
    }));
    const status = await lyricsApp().request(`/api/lyrics/${trackId}/status`);
    expect(await status.json()).toEqual(expect.objectContaining({
      trackId,
      status: "failed",
    }));

    const invalid = await lyricsApp().request("/api/lyrics/bad%2Ftrack/generate", { method: "POST" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Invalid track ID" });

    const missing = await lyricsApp().request("/api/lyrics/not-in-db/generate", { method: "POST" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Could not download track for lyrics generation." });
  });
});
