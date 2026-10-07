import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import videosRoutes from "../routes/videos.js";
import { scoreVideoCandidate, pickBestVideoCandidate } from "../providers/videos.js";
import { seedTrack, setupTestDb, teardownTestDb } from "./setup.js";

function buildApp() {
  const app = new Hono();
  app.route("/api/videos", videosRoutes);
  return app;
}

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

/** Mock the sidecar: /health plus per-path canned payloads. */
function mockSidecar(payloads: Record<string, unknown>): () => void {
  return installFetchMock((input) => {
    const url = String(input);
    if (url.endsWith("/health")) return jsonResponse({ ok: true });
    for (const [fragment, body] of Object.entries(payloads)) {
      if (url.includes(fragment)) return jsonResponse(body);
    }
    return jsonResponse({ error: `unexpected sidecar call: ${url}` }, 404);
  });
}

describe("scoreVideoCandidate", () => {
  const track = { title: "Blinding Lights", artist: "The Weeknd", duration: 200 };

  it("accepts an official video with matching title, artist and duration", () => {
    const score = scoreVideoCandidate(track, {
      videoId: "abc123def45",
      title: "The Weeknd - Blinding Lights (Official Music Video)",
      artist: "The Weeknd",
      duration: 203,
    });
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it("rejects candidates with wildly different durations", () => {
    const score = scoreVideoCandidate(track, {
      videoId: "abc123def45",
      title: "The Weeknd - Blinding Lights (Official Music Video)",
      artist: "The Weeknd",
      duration: 600,
    });
    expect(score).toBe(-1);
  });

  it("rejects videos by unrelated artists", () => {
    const score = scoreVideoCandidate(track, {
      videoId: "abc123def45",
      title: "Blinding Lights cover",
      artist: "Random Cover Channel",
      duration: 200,
    });
    expect(score).toBe(-1);
  });

  it("rejects unrelated titles even when the artist matches", () => {
    const score = scoreVideoCandidate(track, {
      videoId: "abc123def45",
      title: "The Weeknd - Save Your Tears (Official Video)",
      artist: "The Weeknd",
      duration: 205,
    });
    expect(score).toBe(-1);
  });

  it("accepts uploads where the artist only appears in the title", () => {
    const score = scoreVideoCandidate(track, {
      videoId: "abc123def45",
      title: "The Weeknd – Blinding Lights",
      artist: "Music Video Channel",
      duration: 201,
    });
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it("pickBestVideoCandidate prefers the closest match and tolerates junk", () => {
    const best = pickBestVideoCandidate(track, [
      { videoId: "junk0000000", title: "Blinding Lights 10 hours loop", artist: "Loop Central", duration: 36000 },
      { videoId: "live0000000", title: "The Weeknd - Blinding Lights (Live at Coachella)", artist: "The Weeknd", duration: 480 },
      { videoId: "good0000000", title: "The Weeknd - Blinding Lights (Official Video)", artist: "The Weeknd", duration: 200 },
    ]);
    expect(best?.videoId).toBe("good0000000");
  });
});

describe("Videos API", () => {
  let restoreEnv: (() => void) | null = null;

  beforeEach(() => {
    setupTestDb();
    process.env.MUSAIC_SECRET_KEY = "test-secret";
    restoreEnv = () => {
      delete process.env.MUSAIC_SECRET_KEY;
    };
  });

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = null;
    teardownTestDb();
  });

  it("returns 404 for an unknown track", async () => {
    const res = await buildApp().request("/api/videos/for-track/nope");
    expect(res.status).toBe(404);
  });

  it("fast-paths youtube-sourced tracks without a sidecar search", async () => {
    const trackId = seedTrack({ id: "yt_4NRXx6U8ABQ", source: "youtube", title: "Blinding Lights", artist: "The Weeknd", duration: 200 });
    const res = await buildApp().request(`/api/videos/for-track/${encodeURIComponent(trackId)}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { available: boolean; videoId: string };
    expect(body.available).toBe(true);
    expect(body.videoId).toBe("4NRXx6U8ABQ");

    // Second call must come from the cache (same payload, still no fetch).
    const again = await buildApp().request(`/api/videos/for-track/${encodeURIComponent(trackId)}`);
    expect(again.status).toBe(200);
  });

  it("matches a local track via sidecar video search and caches the result", async () => {
    const trackId = seedTrack({ id: "local_1", source: "local", title: "Blinding Lights", artist: "The Weeknd", duration: 200 });
    const restore = mockSidecar({
      "/yt/search-videos": {
        videos: [
          {
            videoId: "fHI8X4OXluQ",
            title: "The Weeknd - Blinding Lights (Official Video)",
            artist: "The Weeknd",
            duration: 202,
            thumbnailUrl: "https://i.ytimg.com/thumb.jpg",
          },
        ],
      },
    });
    try {
      const res = await buildApp().request(`/api/videos/for-track/${trackId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { available: boolean; videoId: string; channel: string };
      expect(body.available).toBe(true);
      expect(body.videoId).toBe("fHI8X4OXluQ");
      expect(body.channel).toBe("The Weeknd");
    } finally {
      restore();
    }

    // Cached: now with a fetch mock that would fail any sidecar call.
    const restoreFailing = installFetchMock(() => jsonResponse({ error: "boom" }, 500));
    try {
      const res = await buildApp().request(`/api/videos/for-track/${trackId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { available: boolean; videoId: string };
      expect(body.available).toBe(true);
      expect(body.videoId).toBe("fHI8X4OXluQ");
    } finally {
      restoreFailing();
    }
  });

  it("caches a negative outcome when nothing acceptable is found", async () => {
    const trackId = seedTrack({ id: "local_2", source: "local", title: "Obscure Demo", artist: "Nobody", duration: 200 });
    const restore = mockSidecar({ "/yt/search-videos": { videos: [] } });
    try {
      const res = await buildApp().request(`/api/videos/for-track/${trackId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { available: boolean };
      expect(body.available).toBe(false);
    } finally {
      restore();
    }

    const restoreFailing = installFetchMock(() => jsonResponse({ error: "boom" }, 500));
    try {
      const res = await buildApp().request(`/api/videos/for-track/${trackId}`);
      const body = await res.json() as { available: boolean };
      expect(body.available).toBe(false);
    } finally {
      restoreFailing();
    }
  });

  it("degrades to available:false when the sidecar search fails", async () => {
    const trackId = seedTrack({ id: "local_3", source: "local", title: "Song", artist: "Artist", duration: 180 });
    const restore = installFetchMock((input) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse({ error: "upstream exploded" }, 500);
    });
    try {
      const res = await buildApp().request(`/api/videos/for-track/${trackId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { available: boolean };
      expect(body.available).toBe(false);
    } finally {
      restore();
    }
  });

  it("resolves a playable video URL and surfaces its expiry", async () => {
    const restore = mockSidecar({
      "/yt/video-stream/abc123def45": {
        url: "https://rr3---sn.googlevideo.com/videoplayback?expire=1893456000&sig=abc",
        ext: "mp4",
        duration: 200,
      },
    });
    try {
      const res = await buildApp().request("/api/videos/abc123def45/resolve");
      expect(res.status).toBe(200);
      const body = await res.json() as { url: string; expiresAt: number; duration: number };
      expect(body.url).toContain("googlevideo");
      expect(body.expiresAt).toBe(1893456000);
      expect(body.duration).toBe(200);
    } finally {
      restore();
    }
  });

  it("rejects malformed video ids on resolve", async () => {
    const res = await buildApp().request("/api/videos/..%2F..%2Fetc/resolve");
    expect([400, 404]).toContain(res.status);
  });
});
