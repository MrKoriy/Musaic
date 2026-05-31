import { Hono } from "hono";
import { getYouTubeProvider } from "../providers/youtube.js";
import { sidecarInstalled } from "../providers/sidecar.js";

const router = new Hono();

/** GET /api/youtube/status — whether the sidecar is installed (no auth needed) */
router.get("/status", (c) => {
  return c.json({ available: sidecarInstalled() });
});

/** GET /api/youtube/search?q=&count= */
router.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q?.trim()) return c.json({ error: "q required" }, 400);
  const count = Math.min(Number(c.req.query("count") ?? 30), 100);
  try {
    const tracks = await getYouTubeProvider().search(q, count, 0);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** GET /api/youtube/stream/:trackId */
router.get("/stream/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    const url = await getYouTubeProvider().getStreamUrl(trackId);
    return c.json({ url });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** GET /api/youtube/track/:trackId */
router.get("/track/:trackId", async (c) => {
  try {
    const meta = await getYouTubeProvider().getTrackMetadata(c.req.param("trackId"));
    return c.json(meta);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** GET /api/youtube/artist/:artistName */
router.get("/artist/:artistName", async (c) => {
  const artistName = decodeURIComponent(c.req.param("artistName"));
  try {
    const tracks = await getYouTubeProvider().getArtistTracks(artistName);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default router;
