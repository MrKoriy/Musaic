import { Hono } from "hono";
import { getVKProvider } from "../providers/vk.js";
import path from "path";
import fs from "fs";

const router = new Hono();

const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR ?? path.join(process.cwd(), "downloads");

/**
 * POST /api/vk/auth
 * Body: { username: string, password: string }
 */
router.post("/auth", async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>();
  if (!body.username || !body.password) {
    return c.json({ error: "username and password required" }, 400);
  }
  try {
    await getVKProvider().authenticate(body.username, body.password);
    return c.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // 2FA redirect case
    if (msg.includes("need_validation") || msg.includes("2FA")) {
      return c.json({ error: msg, requires2FA: true }, 403);
    }
    return c.json({ error: msg }, 401);
  }
});

/**
 * GET /api/vk/status
 */
router.get("/status", (c) => {
  return c.json({ authenticated: getVKProvider().isAuthenticated() });
});

/**
 * GET /api/vk/search?q=artist+song&count=50
 */
router.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q?.trim()) return c.json({ error: "q required" }, 400);
  try {
    const tracks = await getVKProvider().search(q);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/stream/:trackId
 * Returns the stream URL for a VK track (re-fetched if expired)
 */
router.get("/stream/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    const url = await getVKProvider().getStreamUrl(trackId);
    return c.json({ url });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/track/:trackId
 * Returns track metadata
 */
router.get("/track/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    const meta = await getVKProvider().getTrackMetadata(trackId);
    return c.json(meta);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/artist/:artistName
 */
router.get("/artist/:artistName", async (c) => {
  const artistName = decodeURIComponent(c.req.param("artistName"));
  try {
    const tracks = await getVKProvider().getArtistTracks(artistName);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/library?offset=0&count=100
 */
router.get("/library", async (c) => {
  const offset = Number(c.req.query("offset") ?? 0);
  const count = Math.min(Number(c.req.query("count") ?? 100), 100);
  try {
    const tracks = await getVKProvider().getUserLibrary(offset, count);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/vk/download
 * Body: { trackId: string }
 */
router.post("/download", async (c) => {
  const body = await c.req.json<{ trackId?: string }>();
  if (!body.trackId) return c.json({ error: "trackId required" }, 400);
  try {
    const localPath = await getVKProvider().downloadTrack(body.trackId, DOWNLOADS_DIR);
    return c.json({ ok: true, localPath });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/recommendations?count=50
 */
router.get("/recommendations", async (c) => {
  const count = Math.min(Number(c.req.query("count") ?? 50), 100);
  try {
    const tracks = await getVKProvider().getRecommendations(count);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /audio/vk/:trackId — proxy/redirect to VK stream URL
 * App uses this to avoid exposing the raw VK URL
 */
router.get("/proxy/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    const url = await getVKProvider().getStreamUrl(trackId);
    // Redirect to the actual VK CDN URL
    return c.redirect(url, 302);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default router;
