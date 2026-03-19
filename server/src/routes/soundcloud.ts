import { Hono } from "hono";
import { getSoundCloudProvider } from "../providers/soundcloud.js";

const router = new Hono();

/**
 * GET /api/sc/status
 */
router.get("/status", async (c) => {
  const hasId = await getSoundCloudProvider().hasClientId();
  return c.json({ clientIdAvailable: hasId });
});

/**
 * POST /api/sc/refresh-client-id
 * Manually trigger client_id re-extraction
 */
router.post("/refresh-client-id", async (c) => {
  try {
    const id = await getSoundCloudProvider().refreshClientId();
    return c.json({ ok: true, clientIdPrefix: id.substring(0, 8) + "..." });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/sc/search?q=query&limit=30
 */
router.get("/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ error: "q required" }, 400);
  try {
    const tracks = await getSoundCloudProvider().search(q);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/sc/stream/:trackId
 */
router.get("/stream/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    const url = await getSoundCloudProvider().getStreamUrl(trackId);
    return c.json({ url });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/sc/track/:trackId
 */
router.get("/track/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    const meta = await getSoundCloudProvider().getTrackMetadata(trackId);
    return c.json(meta);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/sc/artist/:artistId
 * artistId can be a username (string) or numeric user ID
 */
router.get("/artist/:artistId", async (c) => {
  const artistId = decodeURIComponent(c.req.param("artistId"));
  try {
    const tracks = await getSoundCloudProvider().getArtistTracks(artistId);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/sc/waveform/:trackId
 * Returns waveform samples array for visualization
 */
router.get("/waveform/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    const samples = await getSoundCloudProvider().getWaveformData(trackId);
    return c.json({ samples });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/sc/proxy/:trackId — redirect to SC stream URL
 */
router.get("/proxy/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    const url = await getSoundCloudProvider().getStreamUrl(trackId);
    // Redirect to the stream URL — RNTP handles both HLS (.m3u8) and progressive streams natively
    return c.redirect(url, 302);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/sc/trending?genre=soundcloud:genres:all-music&limit=20
 * GET /api/sc/trending?kind=top&genre=...
 */
router.get("/trending", async (c) => {
  const kind = (c.req.query("kind") ?? "trending") as "trending" | "top";
  const genre = c.req.query("genre") ?? "soundcloud:genres:all-music";
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);
  try {
    const tracks = await getSoundCloudProvider().getCharts(kind, genre, limit);
    return c.json({ tracks, kind, genre });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/sc/charts?kind=trending&genre=...&limit=20
 * Alias for /trending
 */
router.get("/charts", async (c) => {
  const kind = (c.req.query("kind") ?? "trending") as "trending" | "top";
  const genre = c.req.query("genre") ?? "soundcloud:genres:all-music";
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);
  try {
    const tracks = await getSoundCloudProvider().getCharts(kind, genre, limit);
    return c.json({ tracks, kind, genre });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/sc/likes/:userId
 */
router.get("/likes/:userId", async (c) => {
  const userId = decodeURIComponent(c.req.param("userId"));
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  try {
    const tracks = await getSoundCloudProvider().getUserLikes(userId, limit);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default router;
