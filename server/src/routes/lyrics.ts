/**
 * Lyrics routes
 *
 * GET  /api/lyrics/:trackId         — get cached lyrics or fetch from LRCLIB
 * POST /api/lyrics/:trackId/generate — trigger AI pipeline (async)
 * GET  /api/lyrics/:trackId/status   — poll AI job status
 * PUT  /api/lyrics/:trackId          — save manually edited lyrics
 * DELETE /api/lyrics/:trackId        — clear cached lyrics
 */

import { Hono } from "hono";
import { getCachedLyrics, setCachedLyrics, deleteCachedLyrics, getTrack } from "../db/index.js";
import { fetchLrclib, searchLrclib } from "../providers/lrclib.js";
import { startTranscription, getJobStatus } from "../providers/lyrics-pipeline.js";

const router = new Hono();

/**
 * GET /api/lyrics/:trackId?artist=&title=&duration=
 *
 * 1. Check SQLite cache
 * 2. Try LRCLIB (by artist+title, then by search query)
 * 3. Return null if not found (client should trigger /generate)
 */
router.get("/:trackId", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));

  // 1. Cache hit
  const cached = getCachedLyrics(trackId);
  if (cached) {
    return c.json({ trackId, lrc: cached.lrc, source: cached.source, cached: true });
  }

  // 2. Get artist/title from query params or DB
  const artist = c.req.query("artist") ?? "";
  const title = c.req.query("title") ?? "";
  const duration = c.req.query("duration") ? Number(c.req.query("duration")) : undefined;

  if (!artist || !title) {
    // Try to look up from DB
    const track = getTrack(trackId) as { artist?: string; title?: string; duration?: number } | null;
    if (!track) {
      return c.json({ trackId, lrc: null, source: null, cached: false });
    }
    return fetchAndRespond(c, trackId, track.artist ?? "", track.title ?? "", track.duration);
  }

  return fetchAndRespond(c, trackId, artist, title, duration);
});

async function fetchAndRespond(
  c: Parameters<Parameters<typeof router.get>[1]>[0],
  trackId: string,
  artist: string,
  title: string,
  duration?: number
) {
  // Try LRCLIB exact match
  let result = await fetchLrclib(artist, title, duration);

  // Fallback: LRCLIB search
  if (!result) {
    result = await searchLrclib(`${artist} ${title}`);
  }

  if (result) {
    setCachedLyrics(trackId, result.lrc, result.source);
    return c.json({ trackId, lrc: result.lrc, source: result.source, cached: false });
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
  const body = await c.req.json<{ audioPath?: string }>().catch(() => ({}));

  // Resolve audio path from DB if not provided
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
    // Check if we have cached lyrics (job may have completed in a previous run)
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

export default router;
