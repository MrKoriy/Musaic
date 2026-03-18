/**
 * Local FLAC Library Routes
 *
 * localRouter  → mounted at /api/local
 *   POST /api/local/scan          - Scan a folder and index all audio files
 *   GET  /api/local/status        - Scan status and track count
 *
 * coversRouter → mounted at /api/covers
 *   GET  /api/covers/:trackId     - Serve album art for a track
 *
 * albumsRouter → mounted at /api/albums
 *   GET  /api/albums              - List all albums
 *   GET  /api/albums/artists      - List all artists
 *
 * playlistsRouter → mounted at /api/playlists
 *   GET  /api/playlists           - List playlists
 *   POST /api/playlists           - Create playlist
 *   DELETE /api/playlists/:id     - Delete playlist
 *   GET  /api/playlists/:id/tracks
 *   POST /api/playlists/:id/tracks
 *   DELETE /api/playlists/:id/tracks/:trackId
 */

import { Hono } from "hono";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseFile } from "music-metadata";
import {
  getDb,
  upsertTrack,
  setCoverData,
  getCoverData,
  updateTrackCoverUrl,
  getPlaylists,
  createPlaylist,
  deletePlaylist,
  getPlaylistTracks,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
} from "../db/index.js";
import { fetchOnlineArtwork } from "../providers/artwork.js";

const AUDIO_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".wav", ".ogg", ".opus", ".aiff", ".aif"]);

let scanStatus: { scanning: boolean; scanned: number; total: number; lastScanAt: number | null } = {
  scanning: false,
  scanned: 0,
  total: 0,
  lastScanAt: null,
};

/** Recursively walk a directory and return all audio file paths */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // Skip inaccessible dirs
  }
  return results;
}

/** Process a single audio file: extract metadata and index into SQLite */
async function indexFile(filePath: string): Promise<void> {
  const id = "local_" + crypto.createHash("sha1").update(filePath).digest("hex");
  try {
    const meta = await parseFile(filePath, { skipCovers: false, duration: true });
    const common = meta.common;
    const format = meta.format;

    const title = common.title || path.basename(filePath, path.extname(filePath));
    const artist = common.artist || common.albumartist || "Unknown Artist";
    const album = common.album || "Unknown Album";
    const duration = Math.round(format.duration ?? 0);
    const bitrate = format.bitrate ? Math.round(format.bitrate / 1000) : undefined;

    let coverUrl: string | undefined;
    const picture = common.picture?.[0];
    if (picture) {
      const buf = Buffer.from(picture.data);
      setCoverData(id, buf, picture.format || "image/jpeg");
      coverUrl = `/api/covers/${encodeURIComponent(id)}`;
    }

    upsertTrack({
      id,
      source: "local",
      title,
      artist,
      album,
      duration,
      cover_url: coverUrl,
      local_path: filePath,
      metadata: { bitrate, format: format.codec, sampleRate: format.sampleRate },
    });
  } catch (err) {
    console.error(`[scan] Failed to parse ${filePath}:`, err instanceof Error ? err.message : err);
  }
}

// ─── Scan Router ────────────────────────────────────────────────────────────

export const localRouter = new Hono();

localRouter.post("/scan", async (c) => {
  if (scanStatus.scanning) {
    return c.json({ error: "Scan already in progress", status: scanStatus }, 409);
  }

  const body = await c.req.json<{ dir?: string }>().catch(() => ({} as { dir?: string }));
  const musicDir = body.dir ?? process.env.MUSIC_DIR;

  if (!musicDir) {
    return c.json({ error: "dir required (or set MUSIC_DIR env var)" }, 400);
  }
  if (!fs.existsSync(musicDir)) {
    return c.json({ error: `Directory not found: ${musicDir}` }, 404);
  }

  scanStatus = { scanning: true, scanned: 0, total: 0, lastScanAt: null };

  (async () => {
    try {
      const files = walkDir(musicDir);
      scanStatus.total = files.length;
      console.log(`[scan] Found ${files.length} audio files in ${musicDir}`);

      for (const file of files) {
        await indexFile(file);
        scanStatus.scanned++;
        if (scanStatus.scanned % 50 === 0) {
          console.log(`[scan] Progress: ${scanStatus.scanned}/${scanStatus.total}`);
        }
      }

      scanStatus.lastScanAt = Date.now();
      console.log(`[scan] Done: ${scanStatus.scanned} tracks indexed`);

      // Background: fetch online artwork for tracks that have no embedded cover
      const db = getDb();
      const noArt = db
        .prepare("SELECT id, artist, title FROM tracks WHERE cover_url IS NULL AND source = 'local'")
        .all() as Array<{ id: string; artist: string; title: string }>;
      if (noArt.length > 0) {
        console.log(`[artwork] Fetching online artwork for ${noArt.length} tracks...`);
        let fetched = 0;
        for (const track of noArt) {
          const result = await fetchOnlineArtwork(track.artist, track.title);
          if (result) {
            updateTrackCoverUrl(track.id, result.url);
            fetched++;
          }
          // 100 ms delay to be polite to free APIs
          await new Promise((r) => setTimeout(r, 100));
        }
        console.log(`[artwork] Done: ${fetched}/${noArt.length} artworks fetched`);
      }
    } finally {
      scanStatus.scanning = false;
    }
  })();

  return c.json({ ok: true, message: "Scan started", status: scanStatus });
});

localRouter.get("/status", (c) => {
  const db = getDb();
  const countRow = db.prepare("SELECT COUNT(*) as count FROM tracks WHERE source = 'local'").get() as { count: number };
  return c.json({ ...scanStatus, indexedTracks: countRow.count });
});

// ─── Covers Router ───────────────────────────────────────────────────────────

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

// ─── Albums / Artists Router ─────────────────────────────────────────────────

export const albumsRouter = new Hono();

albumsRouter.get("/", (c) => {
  const db = getDb();
  const source = c.req.query("source");
  const rows = source
    ? db.prepare(`
        SELECT album, artist, COUNT(*) as track_count, MAX(cover_url) as cover_url
        FROM tracks WHERE source = $s AND album IS NOT NULL
        GROUP BY album, artist ORDER BY album ASC
      `).all({ $s: source })
    : db.prepare(`
        SELECT album, artist, COUNT(*) as track_count, MAX(cover_url) as cover_url, source
        FROM tracks WHERE album IS NOT NULL
        GROUP BY album, artist ORDER BY album ASC
      `).all();
  return c.json({ albums: rows });
});

albumsRouter.get("/artists", (c) => {
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

albumsRouter.get("/tracks", (c) => {
  const db = getDb();
  const album = c.req.query("album");
  const artist = c.req.query("artist");
  if (!album) return c.json({ error: "album required" }, 400);
  const rows = artist
    ? db.prepare("SELECT * FROM tracks WHERE album = $album AND artist = $artist ORDER BY title ASC").all({ $album: album, $artist: artist })
    : db.prepare("SELECT * FROM tracks WHERE album = $album ORDER BY title ASC").all({ $album: album });
  return c.json({ tracks: rows });
});

// ─── Artists Router ───────────────────────────────────────────────────────────

export const artistsRouter = new Hono();

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

// ─── Playlists Router ─────────────────────────────────────────────────────────

export const playlistsRouter = new Hono();

playlistsRouter.get("/", (c) => {
  return c.json({ playlists: getPlaylists() });
});

playlistsRouter.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = "playlist_" + crypto.randomBytes(8).toString("hex");
  createPlaylist(id, body.name.trim(), body.description);
  return c.json({ ok: true, id });
});

playlistsRouter.delete("/:id", (c) => {
  deletePlaylist(c.req.param("id"));
  return c.json({ ok: true });
});

playlistsRouter.get("/:id/tracks", (c) => {
  return c.json({ tracks: getPlaylistTracks(c.req.param("id")) });
});

playlistsRouter.post("/:id/tracks", async (c) => {
  const body = await c.req.json<{ trackId?: string; position?: number }>();
  if (!body.trackId) return c.json({ error: "trackId required" }, 400);
  const tracks = getPlaylistTracks(c.req.param("id"));
  addTrackToPlaylist(c.req.param("id"), body.trackId, body.position ?? tracks.length);
  return c.json({ ok: true });
});

playlistsRouter.delete("/:id/tracks/:trackId", (c) => {
  removeTrackFromPlaylist(c.req.param("id"), c.req.param("trackId"));
  return c.json({ ok: true });
});
