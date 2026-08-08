import { Hono } from "hono";
import { getDb, getCoverData, updateTrackCoverUrl } from "../../db/index.js";
import { fetchOnlineArtwork } from "../../providers/artwork.js";

export const coversRouter = new Hono();

/** Trigger online artwork lookup for a specific track */
coversRouter.get("/:trackId/fetch", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const db = getDb();
  const track = db
    .prepare("SELECT id, artist, title FROM tracks WHERE id = $id")
    .get({ $id: trackId }) as { id: string; artist: string; title: string } | null;
  if (!track) return c.json({ error: "Track not found" }, 404);

  const result = await fetchOnlineArtwork(track.artist, track.title);
  if (!result) return c.json({ ok: false, message: "No artwork found" });

  updateTrackCoverUrl(track.id, result.url);
  return c.json({ ok: true, url: result.url, source: result.source });
});

coversRouter.get("/:trackId", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const cover = getCoverData(trackId);
  if (!cover) {
    return c.json({ error: "Cover not found" }, 404);
  }
  return new Response(new Uint8Array(cover.data), {
    status: 200,
    headers: { "Content-Type": cover.mimeType, "Cache-Control": "public, max-age=604800" },
  });
});

export default coversRouter;
