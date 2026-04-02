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
 *
 * downloadsRouter → mounted at /api/downloads
 *   GET  /api/downloads/stream/:trackId - Stream any track for offline download
 */

import { Hono } from "hono";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseFile } from "music-metadata";
import { createReadStream } from "fs";
import {
  getDb,
  upsertTrack,
  setCoverData,
  getCoverData,
  updateTrackCoverUrl,
  getPlaylists,
  normalizePlaylistRow,
  createPlaylist,
  deletePlaylist,
  getPlaylistTracks,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  setPlaylistCoverData,
  getPlaylistCoverData,
  clearPlaylistCoverData,
} from "../db/index.js";
import { fetchOnlineArtwork } from "../providers/artwork.js";
import { getLocalProvider } from "../providers/local.js";

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

function inferMoodFromGenre(genre: string | undefined): string | undefined {
  if (!genre) return undefined;
  const normalized = genre.toLowerCase();

  if (/(ambient|drone|sleep|meditation|classical|new age)/.test(normalized)) return "Sleep, Relax, Focus";
  if (/(house|dance|edm|club|disco|electro|techno|trance)/.test(normalized)) return "Party, Energise";
  if (/(hip hop|rap|trap|drill|grime)/.test(normalized)) return "Workout, Energise";
  if (/(rock|metal|punk|hardcore)/.test(normalized)) return "Workout, Energise";
  if (/(jazz|lofi|lo-fi|chill|downtempo)/.test(normalized)) return "Relax, Focus";
  if (/(r&b|soul|love|romance|ballad)/.test(normalized)) return "Romance, Feel good";
  if (/(pop|funk|indie pop|dance pop)/.test(normalized)) return "Feel good, Party";
  if (/(blues|sad|emo|slowcore)/.test(normalized)) return "Sad";
  return undefined;
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
    const genre = common.genre?.map((entry) => entry.trim()).filter(Boolean).join(", ") || undefined;
    const comments = (common.comment ?? [])
      .map((entry) => typeof entry === "string" ? entry : entry.text ?? "")
      .filter(Boolean);
    const mood =
      comments.find((entry) => /^mood:/i.test(entry))?.replace(/^mood:/i, "").trim() ||
      inferMoodFromGenre(genre);

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
      genre,
      mood,
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
  const configuredMusicDir = process.env.MUSIC_DIR;
  const requestedDir = body.dir?.trim();
  const musicDir = requestedDir ?? configuredMusicDir;

  if (!musicDir) {
    return c.json({ error: "dir required (or set MUSIC_DIR env var)" }, 400);
  }
  const resolvedMusicDir = path.resolve(musicDir);
  if (configuredMusicDir && requestedDir && process.env.ALLOW_SCAN_ANY_DIR !== "1") {
    const allowedDir = path.resolve(configuredMusicDir);
    if (resolvedMusicDir !== allowedDir) {
      return c.json({ error: "Scanning arbitrary directories is disabled. Update MUSIC_DIR or set ALLOW_SCAN_ANY_DIR=1." }, 403);
    }
  }

  if (!fs.existsSync(resolvedMusicDir)) {
    return c.json({ error: `Directory not found: ${resolvedMusicDir}` }, 404);
  }

  scanStatus = { scanning: true, scanned: 0, total: 0, lastScanAt: null };

  (async () => {
    try {
      const files = walkDir(resolvedMusicDir);
      scanStatus.total = files.length;
      console.log(`[scan] Found ${files.length} audio files in ${resolvedMusicDir}`);

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
        // Process in batches of 5 concurrent fetches
        for (let i = 0; i < noArt.length; i += 5) {
          const batch = noArt.slice(i, i + 5);
          const results = await Promise.allSettled(
            batch.map(async (track) => {
              const result = await fetchOnlineArtwork(track.artist, track.title);
              if (result) {
                updateTrackCoverUrl(track.id, result.url);
                return true;
              }
              return false;
            })
          );
          fetched += results.filter((r) => r.status === "fulfilled" && r.value).length;
          // Small delay between batches to be polite to free APIs
          if (i + 5 < noArt.length) await new Promise((r) => setTimeout(r, 200));
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

// ─── Playlists Router ─────────────────────────────────────────────────────────

export const playlistsRouter = new Hono();

playlistsRouter.get("/", (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  return c.json({ playlists: getPlaylists(userId) });
});

playlistsRouter.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = "playlist_" + crypto.randomBytes(8).toString("hex");
  const userId = (c as any).get("userId") as string | undefined;
  createPlaylist(id, body.name.trim(), body.description, userId);
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

// ─── POST /api/playlists/:id/image — upload a custom playlist cover ──────────

playlistsRouter.post("/:id/image", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ imageBase64?: string; mimeType?: string }>();
  if (!body.imageBase64 || !body.mimeType?.startsWith("image/")) {
    return c.json({ error: "imageBase64 and valid mimeType required" }, 400);
  }

  const db = getDb();
  const existing = db.prepare("SELECT id FROM playlists WHERE id = $id").get({ $id: id });
  if (!existing) return c.json({ error: "Playlist not found" }, 404);

  let data: Buffer;
  try {
    data = Buffer.from(body.imageBase64, "base64");
  } catch {
    return c.json({ error: "Invalid imageBase64 payload" }, 400);
  }
  if (!data.length || data.length > 4 * 1024 * 1024) {
    return c.json({ error: "Image is empty or exceeds 4MB" }, 400);
  }

  setPlaylistCoverData(id, data, body.mimeType);
  return c.json({ ok: true, cover_url: `/api/playlists/${encodeURIComponent(id)}/image` });
});

// ─── GET /api/playlists/:id/image — serve a custom playlist cover ───────────

playlistsRouter.get("/:id/image", (c) => {
  const id = c.req.param("id");
  const cover = getPlaylistCoverData(id);
  if (!cover) return c.json({ error: "Cover not found" }, 404);

  return new Response(new Uint8Array(cover.data), {
    status: 200,
    headers: {
      "Content-Type": cover.mimeType,
      "Cache-Control": "public, max-age=604800",
    },
  });
});

// ─── DELETE /api/playlists/:id/image — remove custom playlist cover ─────────

playlistsRouter.delete("/:id/image", (c) => {
  clearPlaylistCoverData(c.req.param("id"));
  return c.json({ ok: true });
});

// ─── PATCH /api/playlists/:id — update name/description ──────────────────────

playlistsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name && body.description === undefined) {
    return c.json({ error: "name or description required" }, 400);
  }
  const db = getDb();
  const existing = db.prepare("SELECT id FROM playlists WHERE id = $id").get({ $id: id });
  if (!existing) return c.json({ error: "Playlist not found" }, 404);

  if (body.name?.trim()) {
    db.prepare("UPDATE playlists SET name = $n, updated_at = unixepoch() WHERE id = $id")
      .run({ $n: body.name.trim(), $id: id });
  }
  if (body.description !== undefined) {
    db.prepare("UPDATE playlists SET description = $d, updated_at = unixepoch() WHERE id = $id")
      .run({ $d: body.description, $id: id });
  }
  return c.json({ ok: true });
});

// ─── GET /api/playlists/:id/cover — 4-grid cover art URLs ────────────────────

playlistsRouter.get("/:id/cover", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.cover_url FROM tracks t
    JOIN playlist_tracks pt ON t.id = pt.track_id
    WHERE pt.playlist_id = $pid AND t.cover_url IS NOT NULL
    ORDER BY pt.position ASC
    LIMIT 4
  `).all({ $pid: id }) as { cover_url: string }[];

  return c.json({ covers: rows.map((r) => r.cover_url) });
});

// ─── GET /api/playlists/:id — single playlist info ───────────────────────────

playlistsRouter.get("/:id", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const playlist = db.prepare(`
    SELECT
      p.*,
      COUNT(pt.track_id) as track_count,
      CASE WHEN pcd.playlist_id IS NOT NULL THEN 1 ELSE 0 END as has_custom_cover,
      COALESCE(
        CASE
          WHEN pcd.playlist_id IS NOT NULL THEN '/api/playlists/' || p.id || '/image'
          ELSE NULL
        END,
        (
          SELECT t.cover_url
          FROM playlist_tracks pt2
          JOIN tracks t ON t.id = pt2.track_id
          WHERE pt2.playlist_id = p.id AND t.cover_url IS NOT NULL
          ORDER BY pt2.position ASC
          LIMIT 1
        )
      ) as cover_url
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
    LEFT JOIN playlist_cover_data pcd ON p.id = pcd.playlist_id
    WHERE p.id = $id
    GROUP BY p.id
  `).get({ $id: id }) as Record<string, unknown> | null;
  if (!playlist) return c.json({ error: "Not found" }, 404);
  return c.json({ playlist: normalizePlaylistRow(playlist) });
});

// ─── Downloads Router ─────────────────────────────────────────────────────────

export const downloadsRouter = new Hono();

/** Serve a local file with HTTP Range support for AVPlayer seeking */
function serveFileWithRange(filePath: string, rangeHeader: string | null): Response {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] ?? "audio/mpeg";

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1]!, 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = createReadStream(filePath, { start, end });
      return new Response(stream as unknown as ReadableStream, {
        status: 206,
        headers: new Headers({
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Content-Length": String(chunkSize),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
        }),
      });
    }
  }

  const stream = createReadStream(filePath);
  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: new Headers({
      "Content-Type": mime,
      "Content-Length": String(fileSize),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    }),
  });
}

const MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/opus",
  ".aiff": "audio/aiff", ".aif": "audio/aiff",
};

/**
 * GET /api/downloads/stream/:trackId
 * Pipe any track's audio bytes to the client for offline download.
 * - local: streams from disk
 * - vk/soundcloud: fetches from upstream URL and pipes
 */
downloadsRouter.get("/stream/:trackId", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const db = getDb();
  const track = db.prepare("SELECT * FROM tracks WHERE id = $id").get({ $id: trackId }) as {
    id: string; source: string; title: string; local_path?: string;
  } | null;

  if (!track) return c.json({ error: "Track not found" }, 404);

  if (track.source === "local") {
    const filePath = getLocalProvider().getFilePath(trackId);
    if (!filePath || !fs.existsSync(filePath)) {
      return c.json({ error: "Local file not found" }, 404);
    }
    return serveFileWithRange(filePath, c.req.header("range") ?? null);
  }

  // For VK and SoundCloud: download to local cache, then serve with Range support.
  // SoundCloud CDN does NOT support HTTP Range requests (signed CloudFront URLs),
  // so AVPlayer cannot seek in a proxied stream. We must cache locally first.
  const CACHE_DIR = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads");
  const cachedPath = path.join(CACHE_DIR, `${trackId}.mp3`);

  try {
    // Download if not cached
    if (!fs.existsSync(cachedPath)) {
      let upstreamUrl: string;
      if (track.source === "vk") {
        const { getVKProvider } = await import("../providers/vk.js");
        upstreamUrl = await getVKProvider().getStreamUrl(trackId);
      } else {
        const { getSoundCloudProvider } = await import("../providers/soundcloud.js");
        upstreamUrl = await getSoundCloudProvider().getStreamUrl(trackId);
      }

      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const upstream = await fetch(upstreamUrl, { signal: AbortSignal.timeout(60_000) });
      if (!upstream.ok || !upstream.body) {
        return c.json({ error: `Download failed: ${upstream.status}` }, 502);
      }

      const tmpPath = cachedPath + ".tmp";
      const writer = fs.createWriteStream(tmpPath);
      const { Readable } = await import("stream");
      await new Promise<void>((resolve, reject) => {
        Readable.fromWeb(upstream.body as any).pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      fs.renameSync(tmpPath, cachedPath);
    }

    // Serve from cache — use Bun.file() which has native Range support
    return serveFileWithRange(cachedPath, c.req.header("range") ?? null);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Stream error" }, 500);
  }
});

/**
 * GET /api/downloads/compressed/:trackId
 * Download a track transcoded to AAC 128kbps M4A (~3-5MB per song vs 30-50MB FLAC).
 * Query params: bitrate (default 128, max 256)
 */
downloadsRouter.get("/compressed/:trackId", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const bitrate = Math.min(256, Math.max(64, Number(c.req.query("bitrate") ?? 128)));
  const db = getDb();
  const track = db.prepare("SELECT * FROM tracks WHERE id = $id").get({ $id: trackId }) as {
    id: string; source: string; title: string; artist: string; duration: number; local_path?: string;
  } | null;

  if (!track) return c.json({ error: "Track not found" }, 404);

  const CACHE_DIR = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads");
  const compressedDir = path.join(CACHE_DIR, "compressed");
  const compressedPath = path.join(compressedDir, `${trackId}_${bitrate}.m4a`);

  if (fs.existsSync(compressedPath)) {
    return serveFileWithRange(compressedPath, c.req.header("range") ?? null);
  }

  let sourcePath: string;

  if (track.source === "local") {
    const filePath = getLocalProvider().getFilePath(trackId);
    if (!filePath || !fs.existsSync(filePath)) {
      return c.json({ error: "Local file not found" }, 404);
    }
    if (filePath.endsWith(".mp3")) {
      const stat = fs.statSync(filePath);
      if (stat.size < 8 * 1024 * 1024) {
        return serveFileWithRange(filePath, c.req.header("range") ?? null);
      }
    }
    sourcePath = filePath;
  } else {
    const rawCachedPath = path.join(CACHE_DIR, `${trackId}.mp3`);
    if (!fs.existsSync(rawCachedPath)) {
      try {
        let upstreamUrl: string;
        if (track.source === "vk") {
          const { getVKProvider } = await import("../providers/vk.js");
          upstreamUrl = await getVKProvider().getStreamUrl(trackId);
        } else {
          const { getSoundCloudProvider } = await import("../providers/soundcloud.js");
          upstreamUrl = await getSoundCloudProvider().getStreamUrl(trackId);
        }
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const upstream = await fetch(upstreamUrl, { signal: AbortSignal.timeout(60_000) });
        if (!upstream.ok || !upstream.body) {
          return c.json({ error: `Download failed: ${upstream.status}` }, 502);
        }
        const tmpPath = rawCachedPath + ".tmp";
        const writer = fs.createWriteStream(tmpPath);
        const { Readable } = await import("stream");
        await new Promise<void>((resolve, reject) => {
          Readable.fromWeb(upstream.body as any).pipe(writer);
          writer.on("finish", resolve);
          writer.on("error", reject);
        });
        fs.renameSync(tmpPath, rawCachedPath);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "Download error" }, 500);
      }
    }
    sourcePath = rawCachedPath;
  }

  try {
    if (!fs.existsSync(sourcePath)) {
      return c.json({ error: `Source file not found: ${sourcePath}` }, 404);
    }
    fs.mkdirSync(compressedDir, { recursive: true });
    const tmpOut = compressedPath + ".tmp";
    const { spawn: nodeSpawn } = await import("child_process");
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = nodeSpawn("ffmpeg", [
        "-nostdin", "-i", sourcePath,
        "-f", "mp4",          // force MP4 container (AAC-compatible)
        "-c:a", "aac", "-b:a", `${bitrate}k`,
        "-movflags", "+faststart", "-vn", "-y", tmpOut,
      ], { stdio: ["ignore", "inherit", "inherit"], detached: false });
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", (err) => reject(err));
    });
    if (exitCode !== 0) {
      console.error(`[transcode] ffmpeg exit ${exitCode} for ${sourcePath}`);
      try { fs.unlinkSync(tmpOut); } catch {}
      return c.json({ error: `Transcoding failed (ffmpeg exit ${exitCode})` }, 500);
    }
    if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 100) {
      return c.json({ error: "Transcoding produced empty file" }, 500);
    }
    fs.renameSync(tmpOut, compressedPath);
  } catch (err) {
    try { fs.unlinkSync(compressedPath + ".tmp"); } catch {}
    return c.json({ error: err instanceof Error ? err.message : "Transcoding failed" }, 500);
  }

  return serveFileWithRange(compressedPath, c.req.header("range") ?? null);
});

/**
 * GET /api/downloads/info/:trackId
 * Returns estimated/actual size for compressed download.
 */
downloadsRouter.get("/info/:trackId", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const bitrate = Math.min(256, Math.max(64, Number(c.req.query("bitrate") ?? 128)));
  const db = getDb();
  const track = db.prepare("SELECT id, duration, source FROM tracks WHERE id = $id").get({ $id: trackId }) as {
    id: string; duration: number; source: string;
  } | null;

  if (!track) return c.json({ error: "Track not found" }, 404);

  const CACHE_DIR = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads");
  const compressedPath = path.join(CACHE_DIR, "compressed", `${trackId}_${bitrate}.m4a`);

  if (fs.existsSync(compressedPath)) {
    const stat = fs.statSync(compressedPath);
    return c.json({ trackId, sizeBytes: stat.size, cached: true, bitrate });
  }

  const estimatedBytes = Math.ceil((bitrate * 1000 * track.duration) / 8) + 50_000;
  return c.json({ trackId, sizeBytes: estimatedBytes, cached: false, bitrate });
});
