import { Hono } from "hono";
import { getDb } from "../../db/index.js";
import { getArtistProfile, normaliseArtistSources } from "../../providers/artists.js";

export const artistsRouter = new Hono();

artistsRouter.get("/profile", async (c) => {
  const artist = c.req.query("artist")?.trim();
  if (!artist) return c.json({ error: "artist required" }, 400);

  try {
    const profile = await getArtistProfile({
      artist,
      sources: normaliseArtistSources(c.req.query("sources")),
      sourceId: c.req.query("sourceId") ?? undefined,
      preferredSource: c.req.query("source") ?? undefined,
      limit: Number(c.req.query("limit") ?? 100),
    });
    return c.json(profile);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to load artist" }, 500);
  }
});

export default artistsRouter;

artistsRouter.get("/", (c) => {
  const db = getDb();
  const source = c.req.query("source");
  const rows = source
    ? db.prepare(`
        SELECT artist, COUNT(*) as track_count, COUNT(DISTINCT album) as album_count, MAX(cover_url) as cover_url
        FROM tracks WHERE source = $s GROUP BY artist ORDER BY artist ASC
      `).all({ $s: source })
    : db.prepare(`
        SELECT artist, COUNT(*) as track_count, COUNT(DISTINCT album) as album_count, MAX(cover_url) as cover_url
        FROM tracks GROUP BY artist ORDER BY artist ASC
      `).all();
  return c.json({ artists: rows });
});

artistsRouter.get("/tracks", (c) => {
  const db = getDb();
  const artist = c.req.query("artist");
  const source = c.req.query("source");
  if (!artist) return c.json({ error: "artist required" }, 400);

  const rows = source
    ? db.prepare("SELECT * FROM tracks WHERE artist = $artist AND source = $source ORDER BY album ASC, title ASC")
      .all({ $artist: artist, $source: source })
    : db.prepare("SELECT * FROM tracks WHERE artist = $artist ORDER BY album ASC, title ASC")
      .all({ $artist: artist });

  return c.json({ tracks: rows });
});
