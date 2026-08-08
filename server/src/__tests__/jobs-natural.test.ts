import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../db/index.js";
import { runArtistGraphJob } from "../jobs/artist-graph.js";
import { runTagBackfillJob } from "../jobs/tag-backfill.js";
import { logRecommendationQualitySummary } from "../jobs/quality-summary.js";
import { runAudioEmbeddingsJob } from "../jobs/audio-embeddings.js";
import { encodeEmbedding, decodeEmbedding, cosineSimilarity } from "../reco/audio.js";
import { recordScrobble } from "../reco/scrobble.js";
import { normalizeArtistIdentity } from "../utils/track-identity.js";
import { invalidateAllCaches } from "../utils/cache.js";
import { setupTestDb, teardownTestDb, seedTrack } from "./setup.js";

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

describe("natural background jobs", () => {
  let previousKey: string | undefined;

  beforeEach(() => {
    previousKey = process.env.LASTFM_API_KEY;
    process.env.LASTFM_API_KEY = "test-lastfm";
    setupTestDb();
    invalidateAllCaches();
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.LASTFM_API_KEY;
    else process.env.LASTFM_API_KEY = previousKey;
    invalidateAllCaches();
    teardownTestDb();
  });

  it("skips the artist graph without a Last.fm key", async () => {
    delete process.env.LASTFM_API_KEY;
    expect(await runArtistGraphJob()).toEqual({ artists: 0, edges: 0 });
  });

  it("builds related-artist edges from the Last.fm response", async () => {
    seedTrack({ id: "graph-artist-track", artist: "Alpha" });
    getDb().prepare("UPDATE tracks SET play_count = 5 WHERE id = $id").run({ $id: "graph-artist-track" });

    const restore = installFetchMock(() => jsonResponse({
      similarartists: { artist: [{ name: "Beta", match: "0.8" }, { name: "Alpha", match: "1" }] },
    }));
    try {
      const result = await runArtistGraphJob();
      expect(result.artists).toBeGreaterThan(0);
      expect(result.edges).toBe(1);
      const rows = getDb().prepare("SELECT related_key, score FROM related_artists WHERE artist_key = $key")
        .all({ $key: normalizeArtistIdentity("Alpha") }) as Array<{ related_key: string; score: number }>;
      expect(rows).toEqual([{ related_key: normalizeArtistIdentity("Beta"), score: 0.8 }]);
    } finally {
      restore();
    }
  });

  it("backfills track tags and does not re-process recently tagged tracks", async () => {
    seedTrack({ id: "tag-track", title: "Signal", artist: "North Star" });

    const restore = installFetchMock((input) => {
      const url = String(input);
      if (url.includes("track.getTopTags")) {
        return jsonResponse({ toptags: { tag: [{ name: "Electronic", count: 10 }] } });
      }
      return jsonResponse({ toptags: { tag: [] } });
    });
    try {
      const first = await runTagBackfillJob();
      expect(first).toEqual({ processed: 1, tagged: 1 });
      expect(getDb().prepare("SELECT tag, weight, source FROM track_tags WHERE track_id = $id")
        .all({ $id: "tag-track" })).toEqual([{ tag: "electronic", weight: 0.1, source: "lastfm" }]);

      const second = await runTagBackfillJob();
      expect(second.processed).toBe(0);
    } finally {
      restore();
    }
  });

  it("summarizes quality metrics per recommendation surface", () => {
    const now = Math.floor(Date.now() / 1000);
    getDb().prepare(`
      INSERT INTO listening_history (track_id, action, played_at, surface, played_ratio)
      VALUES ('t1', 'skip', $now, 'home', 0.1), ('t2', 'complete', $now, 'home', NULL)
    `).run({ $now: now });

    const summary = logRecommendationQualitySummary(1);
    expect(summary.surfaces).toEqual({
      home: { playbackEvents: 2, earlySkipRate: 0.5, acceptedRate: 0.5 },
    });
  });
});

describe("audio embeddings and scrobble helpers", () => {
  let previousEnabled: string | undefined;
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousEnabled = process.env.AUDIO_EMBEDDINGS_ENABLED;
    previousSecret = process.env.MUSAIC_SECRET_KEY;
    process.env.MUSAIC_SECRET_KEY = "embedding-secret";
    setupTestDb();
    invalidateAllCaches();
  });

  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.AUDIO_EMBEDDINGS_ENABLED;
    else process.env.AUDIO_EMBEDDINGS_ENABLED = previousEnabled;
    if (previousSecret === undefined) delete process.env.MUSAIC_SECRET_KEY;
    else process.env.MUSAIC_SECRET_KEY = previousSecret;
    invalidateAllCaches();
    teardownTestDb();
  });

  it("encodes, decodes, and compares embedding vectors", () => {
    const vector = [1, 2, 3];
    expect(decodeEmbedding(encodeEmbedding(vector))).toEqual([1, 2, 3]);
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([], [1])).toBe(0);
    expect(decodeEmbedding([1, 2])).toEqual([1, 2]);
    expect(decodeEmbedding("nope")).toEqual([]);
  });

  it("skips audio embeddings when disabled", async () => {
    delete process.env.AUDIO_EMBEDDINGS_ENABLED;
    expect(await runAudioEmbeddingsJob()).toEqual({ processed: 0, embedded: 0 });
  });

  it("stores embeddings from the sidecar when enabled", async () => {
    process.env.AUDIO_EMBEDDINGS_ENABLED = "1";
    const trackId = seedTrack({ id: "embed-track", source: "local" });
    getDb().prepare("UPDATE tracks SET local_path = '/tmp/embed.mp3' WHERE id = $id").run({ $id: trackId });

    const restore = installFetchMock((input) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response(null, { status: 200 });
      if (url.includes("/audio/embedding")) return jsonResponse({ vector: [0.25, 0.5], dimensions: 2 });
      return jsonResponse({});
    });
    try {
      const result = await runAudioEmbeddingsJob();
      expect(result).toEqual({ processed: 1, embedded: 1 });
      const row = getDb().prepare("SELECT dimensions FROM audio_embeddings WHERE track_id = $id")
        .get({ $id: trackId }) as { dimensions: number };
      expect(row.dimensions).toBe(2);
    } finally {
      restore();
    }
  });

  it("records scrobbles and validates their input", () => {
    expect(recordScrobble({ trackId: "" }, null)).toEqual({ status: 400, body: { error: "trackId required" } });
    expect(recordScrobble({ trackId: "scrobble-track", action: "bad" }, null))
      .toEqual({ status: 400, body: { error: "Invalid action" } });

    const trackId = seedTrack({ id: "scrobble-track" });
    const result = recordScrobble({ trackId, playedRatio: 0.6 }, null);
    expect(result.status).toBe(200);
    expect((result as { body: { inserted: boolean } }).body.inserted).toBe(true);
    expect(getDb().prepare("SELECT action FROM listening_history WHERE track_id = $id").get({ $id: trackId }))
      .toEqual({ action: "play" });
  });
});
