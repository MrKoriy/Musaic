import { Hono } from "hono";
import { getTrack } from "../db/index.js";
import {
  getCachedTrackVideo,
  matchTrackVideo,
  resolveVideoStreamUrl,
} from "../providers/videos.js";

const router = new Hono();

/**
 * GET /api/videos/for-track/:trackId — the matched music video for a track.
 * Lazy: the first call runs the YouTube match and caches the outcome in
 * track_videos; later calls are a DB read.
 */
router.get("/for-track/:trackId", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  if (!trackId) return c.json({ error: "trackId required" }, 400);

  const cached = getCachedTrackVideo(trackId);
  if (cached) return c.json(cached);

  const track = getTrack(trackId);
  if (!track) return c.json({ error: "Unknown track" }, 404);

  try {
    const info = await matchTrackVideo({
      id: track.id as string,
      source: track.source as string,
      title: track.title as string,
      artist: track.artist as string,
      duration: Number(track.duration ?? 0),
    });
    return c.json(info);
  } catch (err: unknown) {
    // Sidecar/YouTube outages must not break playback UI — report "no video".
    console.warn(`[videos] match failed for ${trackId}: ${err instanceof Error ? err.message : err}`);
    return c.json({ available: false });
  }
});

/**
 * GET /api/videos/:videoId/resolve — a playable muxed (audio+video) URL.
 * Resolved on demand because googlevideo URLs expire (~6h); the client plays
 * the returned URL directly, so video bandwidth never passes through us.
 */
router.get("/:videoId/resolve", async (c) => {
  const videoId = c.req.param("videoId");
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return c.json({ error: "Invalid video id" }, 400);
  try {
    const resolved = await resolveVideoStreamUrl(videoId);
    return c.json(resolved);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Video resolve failed" }, 502);
  }
});

export default router;
