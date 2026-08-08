import { Hono } from "hono";
import { getDb } from "../../db/index.js";

export const albumsRouter = new Hono();

albumsRouter.get("/", (c) => {
  const db = getDb();
  const source = c.req.query("source");
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? 100)), 500);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const rows = source
    ? db.prepare(`
        SELECT album, artist, COUNT(*) as track_count, MAX(cover_url) as cover_url, source
        FROM tracks
        WHERE source = $s AND album IS NOT NULL AND trim(album) <> ''
        GROUP BY album, artist, source
        ORDER BY album ASC, artist ASC
        LIMIT $limit OFFSET $offset
      `).all({ $s: source, $limit: limit, $offset: offset })
    : db.prepare(`
        SELECT album, artist, COUNT(*) as track_count, MAX(cover_url) as cover_url, source
        FROM tracks
        WHERE album IS NOT NULL AND trim(album) <> ''
        GROUP BY album, artist, source
        ORDER BY album ASC, artist ASC
        LIMIT $limit OFFSET $offset
      `).all({ $limit: limit, $offset: offset });
  return c.json({ albums: rows });
});

albumsRouter.get("/artists", (c) => {
  const db = getDb();
  const source = c.req.query("source");
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? 100)), 500);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const rows = source
    ? db.prepare(`
        SELECT artist, COUNT(*) as track_count, COUNT(DISTINCT album) as album_count, MAX(cover_url) as cover_url
        FROM tracks WHERE source = $s GROUP BY artist ORDER BY artist ASC
        LIMIT $limit OFFSET $offset
      `).all({ $s: source, $limit: limit, $offset: offset })
    : db.prepare(`
        SELECT artist, COUNT(*) as track_count, COUNT(DISTINCT album) as album_count, MAX(cover_url) as cover_url
        FROM tracks GROUP BY artist ORDER BY artist ASC
        LIMIT $limit OFFSET $offset
      `).all({ $limit: limit, $offset: offset });
  return c.json({ artists: rows });
});

albumsRouter.get("/tracks", (c) => {
  const db = getDb();
  const album = c.req.query("album");
  const artist = c.req.query("artist");
  const source = c.req.query("source");
  if (!album) return c.json({ error: "album required" }, 400);
  const rows = source
    ? artist
      ? db.prepare("SELECT * FROM tracks WHERE album = $album AND artist = $artist AND source = $source ORDER BY title ASC")
        .all({ $album: album, $artist: artist, $source: source })
      : db.prepare("SELECT * FROM tracks WHERE album = $album AND source = $source ORDER BY title ASC")
        .all({ $album: album, $source: source })
    : artist
      ? db.prepare("SELECT * FROM tracks WHERE album = $album AND artist = $artist ORDER BY title ASC")
        .all({ $album: album, $artist: artist })
      : db.prepare("SELECT * FROM tracks WHERE album = $album ORDER BY title ASC")
        .all({ $album: album });
  return c.json({ tracks: rows });
});

export default albumsRouter;
