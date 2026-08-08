import { Hono } from "hono";
import { streamTrack, StreamProxyError } from "../utils/stream-proxy.js";

const router = new Hono();
const SOURCES = new Set(["local", "vk", "soundcloud", "yandex", "youtube"]);

router.get("/:source/:trackId", async (c) => {
  const source = c.req.param("source");
  const trackId = decodeURIComponent(c.req.param("trackId"));
  if (!SOURCES.has(source) || !trackId) return c.json({ error: "Invalid stream target" }, 400);

  try {
    const quality = c.req.query("quality");
    const requestedBitrate = c.req.query("bitrate");
    const bitrate = requestedBitrate
      ? Number(requestedBitrate)
      : quality === "low" ? 128 : quality === "normal" ? 192 : 320;
    return await streamTrack({
      source,
      trackId,
      bitrate,
      range: c.req.header("range"),
    });
  } catch (error) {
    if (error instanceof StreamProxyError) return c.json({ error: error.message }, error.status);
    return c.json({ error: error instanceof Error ? error.message : "Stream proxy failed" }, 502);
  }
});

export default router;
