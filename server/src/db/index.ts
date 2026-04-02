import { Database } from "bun:sqlite";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "musaic.db");
const CONFIG_SECRET_PATH = process.env.MUSAIC_SECRET_PATH || path.join(path.dirname(DB_PATH), ".musaic.secret");

let _db: Database | null = null;
let _configSecret: Buffer | null = null;

function getConfigSecret(): Buffer {
  if (_configSecret) return _configSecret;

  const envSecret = process.env.MUSAIC_SECRET_KEY?.trim();
  if (envSecret) {
    _configSecret = crypto.createHash("sha256").update(envSecret).digest();
    return _configSecret;
  }

  if (fs.existsSync(CONFIG_SECRET_PATH)) {
    _configSecret = Buffer.from(fs.readFileSync(CONFIG_SECRET_PATH, "utf8").trim(), "base64");
    return _configSecret;
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(CONFIG_SECRET_PATH, generated.toString("base64"), { mode: 0o600 });
  _configSecret = generated;
  return generated;
}

function encryptStoredValue(value: string): string {
  const secret = getConfigSecret();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secret, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

function decryptStoredValue(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith("enc:")) return value;

  const payload = Buffer.from(value.slice(4), "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getConfigSecret(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH, { create: true });
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(source IN ('local', 'vk', 'soundcloud')),
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      duration INTEGER NOT NULL DEFAULT 0,
      cover_url TEXT,
      local_path TEXT,
      waveform_url TEXT,
      mood TEXT,
      genre TEXT,
      play_count INTEGER NOT NULL DEFAULT 0,
      last_played_at INTEGER,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS vk_audio_urls (
      track_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vk_config (
      id INTEGER PRIMARY KEY CHECK(id IN (1, 2)),
      username TEXT,
      password_enc TEXT,
      token TEXT,
      token_expiry INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS listening_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('play', 'pause', 'skip', 'like', 'dislike', 'complete')),
      played_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(playlist_id, track_id)
    );

    CREATE TABLE IF NOT EXISTS playlist_cover_data (
      playlist_id TEXT PRIMARY KEY REFERENCES playlists(id) ON DELETE CASCADE,
      data BLOB NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS cover_data (
      track_id TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'image/jpeg'
    );

    CREATE TABLE IF NOT EXISTS lyrics_cache (
      track_id TEXT PRIMARY KEY,
      lrc TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'lrclib',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
      title, artist, album,
      content='tracks',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
      INSERT INTO tracks_fts(rowid, title, artist, album)
        VALUES (new.rowid, new.title, new.artist, COALESCE(new.album, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
        VALUES ('delete', old.rowid, old.title, old.artist, COALESCE(old.album, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
        VALUES ('delete', old.rowid, old.title, old.artist, COALESCE(old.album, ''));
      INSERT INTO tracks_fts(rowid, title, artist, album)
        VALUES (new.rowid, new.title, new.artist, COALESCE(new.album, ''));
    END;

    -- Performance indexes for hot query paths
    CREATE INDEX IF NOT EXISTS idx_lh_action_played_at ON listening_history(action, played_at);
    CREATE INDEX IF NOT EXISTS idx_lh_track_id ON listening_history(track_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_source ON tracks(source);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_popularity ON tracks(play_count DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tracks_last_played_at ON tracks(last_played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lh_track_played ON listening_history(track_id, played_at);
    CREATE INDEX IF NOT EXISTS idx_tracks_updated_at ON tracks(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tracks_lower_artist ON tracks(lower(artist));
  `);
}

// Track operations
export function upsertTrack(track: {
  id: string;
  source: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  cover_url?: string;
  local_path?: string;
  waveform_url?: string;
  mood?: string;
  genre?: string;
  metadata?: Record<string, unknown>;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO tracks (id, source, title, artist, album, duration, cover_url, local_path, waveform_url, mood, genre, metadata, updated_at)
    VALUES ($id, $source, $title, $artist, $album, $duration, $cover_url, $local_path, $waveform_url, $mood, $genre, $metadata, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      album = excluded.album,
      duration = excluded.duration,
      cover_url = excluded.cover_url,
      local_path = excluded.local_path,
      waveform_url = excluded.waveform_url,
      mood = COALESCE(excluded.mood, tracks.mood),
      genre = COALESCE(excluded.genre, tracks.genre),
      metadata = excluded.metadata,
      updated_at = unixepoch()
  `).run({
    $id: track.id,
    $source: track.source,
    $title: track.title,
    $artist: track.artist,
    $album: track.album ?? null,
    $cover_url: track.cover_url ?? null,
    $local_path: track.local_path ?? null,
    $waveform_url: track.waveform_url ?? null,
    $mood: track.mood ?? null,
    $genre: track.genre ?? null,
    $metadata: track.metadata ? JSON.stringify(track.metadata) : null,
    $duration: track.duration,
  });
}

export function getTrack(id: string): Record<string, unknown> | null {
  const db = getDb();
  return db.prepare("SELECT * FROM tracks WHERE id = $id").get({ $id: id }) as Record<string, unknown> | null;
}

// VK audio URL cache (24h TTL since URLs expire)
const VK_URL_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours

export function getCachedVkUrl(trackId: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT url, fetched_at FROM vk_audio_urls WHERE track_id = $id")
    .get({ $id: trackId }) as { url: string; fetched_at: number } | null;
  if (!row) return null;
  const age = Date.now() - row.fetched_at;
  if (age > VK_URL_TTL_MS) {
    db.prepare("DELETE FROM vk_audio_urls WHERE track_id = $id").run({ $id: trackId });
    return null;
  }
  return row.url;
}

export function setCachedVkUrl(trackId: string, url: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO vk_audio_urls (track_id, url, fetched_at)
    VALUES ($id, $url, $ts)
    ON CONFLICT(track_id) DO UPDATE SET url = excluded.url, fetched_at = excluded.fetched_at
  `).run({ $id: trackId, $url: url, $ts: Date.now() });
}

// VK config (id=1 for VK, id=2 for SoundCloud client_id)
export function getVkConfig(): { token: string | null; tokenExpiry: number | null; username: string | null } {
  const db = getDb();
  const row = db.prepare("SELECT token, token_expiry, username FROM vk_config WHERE id = 1")
    .get() as { token: string | null; token_expiry: number | null; username: string | null } | null;
  if (!row) return { token: null, tokenExpiry: null, username: null };
  return {
    token: decryptStoredValue(row.token),
    tokenExpiry: row.token_expiry,
    username: row.username,
  };
}

export function setVkConfig(config: { username?: string; token?: string; tokenExpiry?: number }): void {
  const db = getDb();
  const encryptedToken = config.token ? encryptStoredValue(config.token) : null;
  db.prepare(`
    INSERT INTO vk_config (id, username, token, token_expiry, updated_at)
    VALUES (1, $username, $token, $token_expiry, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      username = COALESCE($username, username),
      token = COALESCE($token, token),
      token_expiry = COALESCE($token_expiry, token_expiry),
      updated_at = unixepoch()
  `).run({
    $username: config.username ?? null,
    $token: encryptedToken,
    $token_expiry: config.tokenExpiry ?? null,
  });
}

export function clearVkConfig(): void {
  const db = getDb();
  db.prepare("DELETE FROM vk_config WHERE id = 1").run();
}

// Listening history
export function logListening(trackId: string, action: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("INSERT INTO listening_history (track_id, action) VALUES ($id, $action)")
      .run({ $id: trackId, $action: action });

    if (action === "play") {
      db.prepare(`
        UPDATE tracks
        SET play_count = COALESCE(play_count, 0) + 1,
            last_played_at = unixepoch(),
            updated_at = unixepoch()
        WHERE id = $id
      `).run({ $id: trackId });
    }
  })();
}

// Update cover_url on a track (e.g. after fetching online artwork)
export function updateTrackCoverUrl(trackId: string, coverUrl: string): void {
  const db = getDb();
  db.prepare("UPDATE tracks SET cover_url = $url, updated_at = unixepoch() WHERE id = $id")
    .run({ $url: coverUrl, $id: trackId });
}

// Cover art
export function setCoverData(trackId: string, data: Buffer, mimeType: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO cover_data (track_id, data, mime_type)
    VALUES ($id, $data, $mime)
    ON CONFLICT(track_id) DO UPDATE SET data = excluded.data, mime_type = excluded.mime_type
  `).run({ $id: trackId, $data: data, $mime: mimeType });
}

export function getCoverData(trackId: string): { data: Buffer; mimeType: string } | null {
  const db = getDb();
  return db.prepare("SELECT data, mime_type FROM cover_data WHERE track_id = $id")
    .get({ $id: trackId }) as { data: Buffer; mimeType: string } | null;
}

// Playlists
export function normalizePlaylistRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    track_count: Number(row.track_count ?? 0),
    has_custom_cover: Boolean(row.has_custom_cover),
  };
}

export function getPlaylists(): Record<string, unknown>[] {
  const db = getDb();
  const rows = db.prepare(`
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
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `).all() as Record<string, unknown>[];

  return rows.map(normalizePlaylistRow);
}

export function createPlaylist(id: string, name: string, description?: string): void {
  const db = getDb();
  db.prepare("INSERT INTO playlists (id, name, description) VALUES ($id, $name, $desc)")
    .run({ $id: id, $name: name, $desc: description ?? null });
}

export function deletePlaylist(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM playlists WHERE id = $id").run({ $id: id });
}

export function getPlaylistTracks(playlistId: string): Record<string, unknown>[] {
  const db = getDb();
  return db.prepare(`
    SELECT t.* FROM tracks t
    JOIN playlist_tracks pt ON t.id = pt.track_id
    WHERE pt.playlist_id = $pid
    ORDER BY pt.position ASC
  `).all({ $pid: playlistId }) as Record<string, unknown>[];
}

export function addTrackToPlaylist(playlistId: string, trackId: string, position: number): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
      VALUES ($pid, $tid, $pos)
    `).run({ $pid: playlistId, $tid: trackId, $pos: position });
    db.prepare("UPDATE playlists SET updated_at = unixepoch() WHERE id = $id")
      .run({ $id: playlistId });
  })();
}

export function removeTrackFromPlaylist(playlistId: string, trackId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = $pid AND track_id = $tid")
      .run({ $pid: playlistId, $tid: trackId });
    db.prepare("UPDATE playlists SET updated_at = unixepoch() WHERE id = $id")
      .run({ $id: playlistId });
  })();
}

export function setPlaylistCoverData(playlistId: string, data: Buffer, mimeType: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO playlist_cover_data (playlist_id, data, mime_type, updated_at)
    VALUES ($id, $data, $mime, unixepoch())
    ON CONFLICT(playlist_id) DO UPDATE SET
      data = excluded.data,
      mime_type = excluded.mime_type,
      updated_at = unixepoch()
  `).run({ $id: playlistId, $data: data, $mime: mimeType });
  db.prepare("UPDATE playlists SET updated_at = unixepoch() WHERE id = $id").run({ $id: playlistId });
}

export function getPlaylistCoverData(playlistId: string): { data: Buffer; mimeType: string } | null {
  const db = getDb();
  return db.prepare("SELECT data, mime_type FROM playlist_cover_data WHERE playlist_id = $id")
    .get({ $id: playlistId }) as { data: Buffer; mimeType: string } | null;
}

export function clearPlaylistCoverData(playlistId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM playlist_cover_data WHERE playlist_id = $id").run({ $id: playlistId });
  db.prepare("UPDATE playlists SET updated_at = unixepoch() WHERE id = $id").run({ $id: playlistId });
}

// Lyrics cache
export function getCachedLyrics(trackId: string): { lrc: string; source: string } | null {
  const db = getDb();
  return db.prepare("SELECT lrc, source FROM lyrics_cache WHERE track_id = $id")
    .get({ $id: trackId }) as { lrc: string; source: string } | null;
}

export function setCachedLyrics(trackId: string, lrc: string, source: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO lyrics_cache (track_id, lrc, source)
    VALUES ($id, $lrc, $source)
    ON CONFLICT(track_id) DO UPDATE SET lrc = excluded.lrc, source = excluded.source, created_at = unixepoch()
  `).run({ $id: trackId, $lrc: lrc, $source: source });
}

export function deleteCachedLyrics(trackId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM lyrics_cache WHERE track_id = $id").run({ $id: trackId });
}
