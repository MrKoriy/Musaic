import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import lyricsRoutes from "../routes/lyrics.js";
import { getDb } from "../db/index.js";
import { getJobStatus, startTranscription } from "../providers/lyrics-pipeline.js";
import { drainTasksForTest, latestTask, resetTasksForTest } from "../jobs/tasks.js";
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

function lyricsApp(userId?: string): Hono {
  const app = new Hono<{ Variables: { userId: string } }>();
  if (userId) {
    app.use("*", async (c, next) => {
      c.set("userId", userId);
      await next();
    });
  }
  app.route("/api/lyrics", lyricsRoutes);
  return app as unknown as Hono;
}

async function readSSE(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await response.text();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
    const data = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
    if (data) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

describe("lyrics routes", () => {
  beforeEach(() => {
    setupTestDb();
    resetTasksForTest();
  });
  afterEach(() => {
    resetTasksForTest();
    teardownTestDb();
  });

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
      expect(await first.json()).toEqual({ trackId, lrc, source: "lrclib", words: null, offsetSec: 0.4, userOffsetSec: 0, cached: false });
      expect(getDb().prepare("SELECT lrc, source FROM lyrics_cache WHERE track_id = $id").get({ $id: trackId }))
        .toEqual({ lrc, source: "lrclib" });

      const second = await lyricsApp().request(`/api/lyrics/${trackId}`);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ trackId, lrc, source: "lrclib", words: null, offsetSec: 0.4, userOffsetSec: 0, cached: true });
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
        words: null,
        offsetSec: 0.4,
        userOffsetSec: 0,
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
    expect(job).toEqual(expect.objectContaining({ trackId, status: "pending" }));
    // Re-requesting while queued joins the same durable task.
    startTranscription(trackId, "/definitely/not/a/real/audio.mp3");

    await drainTasksForTest();
    // A missing file is permanent: one attempt, no retry.
    expect(latestTask(`lyrics:${trackId}`)).toEqual(expect.objectContaining({ status: "failed", attempts: 1 }));
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

describe("lyrics offsets, events and durable prefetch", () => {
  beforeEach(() => {
    setupTestDb();
    resetTasksForTest();
  });
  afterEach(() => {
    resetTasksForTest();
    teardownTestDb();
  });

  it("stores a clamped per-user offset and returns it with the lyrics", async () => {
    const trackId = seedTrack({ id: "offset-track" });
    getDb().prepare("INSERT INTO lyrics_cache (track_id, lrc, source) VALUES ($id, '[00:01.00] Hi', 'lrclib')").run({ $id: trackId });
    const put = (app: Hono, body: unknown) => app.request(`/api/lyrics/${trackId}/offset`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await put(lyricsApp(), { userOffsetSec: 1 })).status).toBe(401);
    expect((await put(lyricsApp("u1"), { userOffsetSec: "fast" })).status).toBe(400);

    const saved = await put(lyricsApp("u1"), { userOffsetSec: 7.23 });
    expect(await saved.json()).toEqual({ ok: true, trackId, userOffsetSec: 5 });
    const nudged = await put(lyricsApp("u1"), { userOffsetSec: -0.337 });
    expect(await nudged.json()).toEqual({ ok: true, trackId, userOffsetSec: -0.35 });

    const mine = await (await lyricsApp("u1").request(`/api/lyrics/${trackId}`)).json() as { userOffsetSec: number };
    expect(mine.userOffsetSec).toBe(-0.35);
    const theirs = await (await lyricsApp("u2").request(`/api/lyrics/${trackId}`)).json() as { userOffsetSec: number };
    expect(theirs.userOffsetSec).toBe(0);

    await put(lyricsApp("u1"), { userOffsetSec: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM lyrics_user_offsets").get()).toEqual({ n: 0 });
  });

  it("streams the current status and closes for finished or unknown jobs", async () => {
    const trackId = seedTrack({ id: "events-idle-track" });
    const idle = await lyricsApp("u1").request(`/api/lyrics/${trackId}/events`);
    expect(idle.headers.get("content-type")).toContain("text/event-stream");
    expect(await readSSE(idle)).toEqual([{ event: "status", data: { trackId, status: "not_started" } }]);

    getDb().prepare("INSERT INTO lyrics_cache (track_id, lrc, source) VALUES ($id, '[00:01.00] Hi', 'ai')").run({ $id: trackId });
    const cached = await lyricsApp("u1").request(`/api/lyrics/${trackId}/events`);
    expect(await readSSE(cached)).toEqual([{ event: "status", data: { trackId, status: "done", cached: true } }]);
  });

  it("pushes job transitions until the job reaches a terminal state", async () => {
    const trackId = seedTrack({ id: "events-live-track" });
    startTranscription(trackId, "/definitely/not/a/real/audio.mp3");

    const response = await lyricsApp("u1").request(`/api/lyrics/${trackId}/events`);
    const events = readSSE(response);
    await drainTasksForTest();
    const statuses = (await events).map((e) => e.data.status);
    expect(statuses[0]).toBe("pending");
    expect(statuses.at(-1)).toBe("failed");
    expect(statuses).toContain("running");
    expect((await events).at(-1)?.data.error).toBe("Audio file not found: /definitely/not/a/real/audio.mp3");
  });

  it("runs prefetch-all as a single durable task", async () => {
    const trackId = seedTrack({ id: "prefetch-track", artist: "Prefetch Artist", title: "Prefetch Song" });
    const lrc = "[00:01.00] Prefetched";
    const restoreFetch = installFetchMock(() => jsonResponse({ id: 1, syncedLyrics: lrc, plainLyrics: "Prefetched" }));
    try {
      const first = await lyricsApp("u1").request("/api/lyrics/prefetch-all", { method: "POST" });
      expect(await first.json()).toEqual(expect.objectContaining({ ok: true, queued: 1 }));
      await lyricsApp("u1").request("/api/lyrics/prefetch-all", { method: "POST" });
      const queued = getDb().prepare("SELECT COUNT(*) AS n FROM background_tasks WHERE type = 'lyrics.prefetch'").get();
      expect(queued).toEqual({ n: 1 });

      await drainTasksForTest();
      expect(latestTask("lyrics-prefetch:all")).toEqual(expect.objectContaining({
        status: "done",
        result: { fetched: 1, missed: 0 },
      }));
      expect(getDb().prepare("SELECT lrc FROM lyrics_cache WHERE track_id = $id").get({ $id: trackId })).toEqual({ lrc });
    } finally {
      restoreFetch();
    }
  });
});
