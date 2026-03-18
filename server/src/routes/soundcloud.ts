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
    // For HLS streams, return URL directly (can't redirect HLS)
    if (url.includes(".m3u8")) {
      return c.json({ url, type: "hls" });
    }
    return c.redirect(url, 302);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default router;
