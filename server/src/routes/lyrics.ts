/**
 * Lyrics routes
 *
 * GET  /api/lyrics/:trackId         — get cached lyrics or fetch from LRCLIB → Genius → lyrics.ovh
 * POST /api/lyrics/:trackId/generate — trigger AI pipeline (async)
 * GET  /api/lyrics/:trackId/status   — poll AI job status
 * PUT  /api/lyrics/:trackId          — save manually edited lyrics
 * DELETE /api/lyrics/:trackId        — clear cached lyrics
 * POST /api/lyrics/prefetch-all      — background pre-fetch for all tracks without lyrics
 */

import { Hono } from "hono";
import { getCachedLyrics, setCachedLyrics, deleteCachedLyrics, getTrack } from "../db/index.js";
import { fetchLrclib, searchLrclib } from "../providers/lrclib.js";
import { fetchPlainLyrics } from "../providers/genius.js";
import { startTranscription, getJobStatus, getPipelineStatus } from "../providers/lyrics-pipeline.js";
import { getDb } from "../db/index.js";

const router = new Hono();

/**
 * GET /api/lyrics/pipeline/ready — check if AI pipeline dependencies are available
 */
router.get("/pipeline/ready", async (c) => {
  const status = await getPipelineStatus();
  return c.json(status, status.ready ? 200 : 503);
});

/**
 * GET /api/lyrics/:trackId?artist=&title=&duration=
 *
 * Fetch chain:
 *   1. SQLite cache (instant)
 *   2. LRCLIB exact match (synced LRC preferred)
 *   3. LRCLIB search fallback
 *   4. Genius API or lyrics.ovh (plain text, no timestamps)
 *   5. Return null — client should trigger /generate
 */
router.get("/:trackId", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));

  // 1. Cache hit
  const cached = getCachedLyrics(trackId);
  if (cached) {
    return c.json({ trackId, lrc: cached.lrc, source: cached.source, cached: true });
  }

  // 2. Resolve artist/title
  const artist = c.req.query("artist") ?? "";
  const title = c.req.query("title") ?? "";
  const duration = c.req.query("duration") ? Number(c.req.query("duration")) : undefined;

  if (!artist || !title) {
    const track = getTrack(trackId) as { artist?: string; title?: string; duration?: number } | null;
    if (!track) {
      return c.json({ trackId, lrc: null, source: null, cached: false });
    }
    return fetchAndRespond(c, trackId, track.artist ?? "", track.title ?? "", track.duration);
  }

  return fetchAndRespond(c, trackId, artist, title, duration);
});

async function fetchAndRespond(
  c: any,
  trackId: string,
  artist: string,
  title: string,
  duration?: number
) {
  // 1. LRCLIB exact match
  let result = await fetchLrclib(artist, title, duration);

  // 2. LRCLIB search fallback
  if (!result) {
    result = await searchLrclib(`${artist} ${title}`);
  }

  if (result) {
    setCachedLyrics(trackId, result.lrc, result.source);
    return c.json({ trackId, lrc: result.lrc, source: result.source, cached: false });
  }

  // 3. Genius / lyrics.ovh plain-text fallback
  const plain = await fetchPlainLyrics(artist, title);
  if (plain) {
    setCachedLyrics(trackId, plain.lyrics, plain.source);
    return c.json({ trackId, lrc: plain.lyrics, source: plain.source, cached: false });
  }

  return c.json({ trackId, lrc: null, source: null, cached: false });
}

/**
 * POST /api/lyrics/:trackId/generate
 * Body: { audioPath: string } (path on server filesystem)
 * Starts async AI pipeline; returns job status.
 */
router.post("/:trackId/generate", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const body = await c.req.json<{ audioPath?: string }>().catch(() => ({} as { audioPath?: string }));

  let audioPath = body.audioPath;
  if (!audioPath) {
    const track = getTrack(trackId) as { local_path?: string } | null;
    audioPath = track?.local_path ?? undefined;
  }

  if (!audioPath) {
    return c.json({ error: "audioPath required (or track must have local_path in DB)" }, 400);
  }

  const job = startTranscription(trackId, audioPath);
  return c.json({ trackId, status: job.status, startedAt: job.startedAt });
});

/**
 * GET /api/lyrics/:trackId/status — poll AI transcription job
 */
router.get("/:trackId/status", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const job = getJobStatus(trackId);

  if (!job) {
    const cached = getCachedLyrics(trackId);
    if (cached) {
      return c.json({ trackId, status: "done", cached: true });
    }
    return c.json({ trackId, status: "not_started" });
  }

  return c.json({
    trackId,
    status: job.status,
    startedAt: job.startedAt,
    error: job.error,
  });
});

/**
 * PUT /api/lyrics/:trackId — save manually edited lyrics
 * Body: { lrc: string }
 */
router.put("/:trackId", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const body = await c.req.json<{ lrc: string }>();
  if (!body.lrc) return c.json({ error: "lrc required" }, 400);

  setCachedLyrics(trackId, body.lrc, "manual");
  return c.json({ ok: true, trackId, source: "manual" });
});

/**
 * DELETE /api/lyrics/:trackId — clear cached lyrics
 */
router.delete("/:trackId", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  deleteCachedLyrics(trackId);
  return c.json({ ok: true, trackId });
});

/**
 * POST /api/lyrics/prefetch-all
 * Background pre-fetch lyrics for all local tracks that don't have cached lyrics yet.
 * Returns immediately; runs in background.
 */
router.post("/prefetch-all", (c) => {
  const db = getDb();
  const tracks = db
    .prepare(`
      SELECT t.id, t.artist, t.title, t.duration
      FROM tracks t
      WHERE t.source = 'local'
        AND NOT EXISTS (SELECT 1 FROM lyrics_cache lc WHERE lc.track_id = t.id)
      LIMIT 200
    `)
    .all() as Array<{ id: string; artist: string; title: string; duration: number }>;

  const total = tracks.length;
  if (total === 0) {
    return c.json({ ok: true, queued: 0, message: "All local tracks already have lyrics cached" });
  }

  // Fire-and-forget background prefetch
  prefetchLyricsInBackground(tracks);

  return c.json({ ok: true, queued: total, message: `Prefetching lyrics for ${total} tracks in background` });
});

async function prefetchLyricsInBackground(
  tracks: Array<{ id: string; artist: string; title: string; duration: number }>
): Promise<void> {
  console.log(`[lyrics] Background prefetch started for ${tracks.length} tracks`);
  let fetched = 0;
  let failed = 0;

  for (const track of tracks) {
    if (!track.artist || !track.title) continue;

    try {
      // Check cache again (may have been filled since query)
      const cached = getCachedLyrics(track.id);
      if (cached) continue;

      // Try LRCLIB first
      let result = await fetchLrclib(track.artist, track.title, track.duration);
      if (!result) {
        result = await searchLrclib(`${track.artist} ${track.title}`);
      }

      if (result) {
        setCachedLyrics(track.id, result.lrc, result.source);
        fetched++;
      } else {
        // Try plain lyrics fallback
        const plain = await fetchPlainLyrics(track.artist, track.title);
        if (plain) {
          setCachedLyrics(track.id, plain.lyrics, plain.source);
          fetched++;
        } else {
          failed++;
        }
      }

      // Small delay to avoid hammering APIs
      await new Promise((r) => setTimeout(r, 300));
    } catch (err: unknown) {
      console.warn(`[lyrics] Prefetch failed for "${track.artist} - ${track.title}":`, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  console.log(`[lyrics] Background prefetch done — fetched: ${fetched}, not found: ${failed}`);
}

export default router;
