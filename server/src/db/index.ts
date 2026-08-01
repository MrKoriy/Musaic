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

  try {
    const payload = Buffer.from(value.slice(4), "base64");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getConfigSecret(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch (err) {
    console.error("[db] Failed to decrypt stored secret (master key changed or secret missing):", err);
    return null;
  }
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

export function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      -- No CHECK on source: the provider set evolves (local/vk/soundcloud/
      -- yandex/youtube/…) and is validated in the app layer. See
      -- dropTracksSourceCheck() for the one-time migration off the old CHECK.
      source TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS yandex_config (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      username TEXT,
      token TEXT,
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

const TRACKS_COLUMNS =
  "id, source, title, artist, album, duration, cover_url, local_path, waveform_url, " +
  "mood, genre, play_count, last_played_at, metadata, created_at, updated_at";

/**
 * One-time rebuild of the `tracks` table to drop the legacy
 * `CHECK(source IN ('local','vk','soundcloud'))` constraint so yandex/youtube
 * (and future) sources can be cached.
 *
 * Must run AFTER column migrations (so every column referenced below exists).
 * SQLite can't ALTER a CHECK, so we recreate the table. Foreign keys are
 * disabled during the swap — otherwise DROP TABLE tracks would implicitly
 * DELETE all rows and cascade into playlist_tracks, wiping playlist contents.
 * No-op on fresh DBs (which never had the CHECK).
 */
export function dropTracksSourceCheck(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tracks'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql || !/CHECK\s*\(\s*source\s+IN/i.test(row.sql)) return; // already migrated / fresh

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec("DROP TRIGGER IF EXISTS tracks_ai");
    db.exec("DROP TRIGGER IF EXISTS tracks_ad");
    db.exec("DROP TRIGGER IF EXISTS tracks_au");
    db.exec(`
      CREATE TABLE tracks_new (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
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
      )
    `);
    db.exec(`INSERT INTO tracks_new (${TRACKS_COLUMNS}) SELECT ${TRACKS_COLUMNS} FROM tracks`);
    db.exec("DROP TABLE tracks");
    db.exec("ALTER TABLE tracks_new RENAME TO tracks");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw err;
  }
  db.exec("PRAGMA foreign_keys = ON");

  // Restore indexes + FTS triggers dropped with the old table, then repopulate
  // the external-content FTS index from the rebuilt table.
  initSchema(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(album, artist)");
  db.exec("INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')");
  console.log("[db] migrated tracks table: dropped legacy source CHECK constraint");
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

// Yandex Music config (single row, id=1). Token is the account OAuth token,
// stored encrypted at rest exactly like the VK token.
export function getYandexConfig(): { token: string | null; username: string | null } {
  const db = getDb();
  const row = db.prepare("SELECT token, username FROM yandex_config WHERE id = 1")
    .get() as { token: string | null; username: string | null } | null;
  if (!row) return { token: null, username: null };
  return { token: decryptStoredValue(row.token), username: row.username };
}

export function setYandexConfig(config: { username?: string; token?: string }): void {
  const db = getDb();
  const encryptedToken = config.token ? encryptStoredValue(config.token) : null;
  db.prepare(`
    INSERT INTO yandex_config (id, username, token, updated_at)
    VALUES (1, $username, $token, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      username = COALESCE($username, username),
      token = COALESCE($token, token),
      updated_at = unixepoch()
  `).run({ $username: config.username ?? null, $token: encryptedToken });
}

export function clearYandexConfig(): void {
  const db = getDb();
  db.prepare("DELETE FROM yandex_config WHERE id = 1").run();
}

// Listening history
export interface ListeningEventDetails {
  eventId?: string | null;
  playedMs?: number | null;
  durationMs?: number | null;
  playedRatio?: number | null;
  sessionId?: string | null;
  requestId?: string | null;
  surface?: string | null;
  isOrganic?: boolean;
  position?: number | null;
  context?: Record<string, unknown> | null;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function logListening(
  trackId: string,
  action: string,
  userId?: string | null,
  details: ListeningEventDetails = {}
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const uid = userId ?? null;
    const eventId = details.eventId?.trim() || null;
    const duplicate = eventId
      ? db.prepare("SELECT 1 FROM listening_history WHERE event_id = $eventId LIMIT 1")
          .get({ $eventId: eventId })
      : db.prepare(`
          SELECT 1 FROM listening_history
          WHERE track_id = $id
            AND action = $action
            AND (user_id = $uid OR (user_id IS NULL AND $uid IS NULL))
            AND played_at >= unixepoch() - 5
          LIMIT 1
        `).get({ $id: trackId, $action: action, $uid: uid });

    if (duplicate) return false;

    const playedMs = finiteNonNegative(details.playedMs);
    const durationMs = finiteNonNegative(details.durationMs);
    const explicitRatio = finiteNonNegative(details.playedRatio);
    const computedRatio = explicitRatio ??
      (playedMs != null && durationMs != null && durationMs > 0
        ? playedMs / durationMs
        : action === "complete" ? 1 : null);
    const playedRatio = computedRatio == null ? null : Math.min(2, computedRatio);

    db.prepare(`
      INSERT INTO listening_history (
        event_id, track_id, action, user_id, played_ms, duration_ms, played_ratio,
        session_id, request_id, surface, is_organic, position, context
      ) VALUES (
        $eventId, $id, $action, $uid, $playedMs, $durationMs, $playedRatio,
        $sessionId, $requestId, $surface, $isOrganic, $position, $context
      )
    `).run({
      $eventId: eventId,
      $id: trackId,
      $action: action,
      $uid: uid,
      $playedMs: playedMs,
      $durationMs: durationMs,
      $playedRatio: playedRatio,
      $sessionId: details.sessionId?.trim() || null,
      $requestId: details.requestId?.trim() || null,
      $surface: details.surface?.trim() || null,
      $isOrganic: details.isOrganic === false ? 0 : 1,
      $position: finiteNonNegative(details.position),
      $context: details.context ? JSON.stringify(details.context) : null,
    });

    // A completed track or a manually advanced track heard past halfway both
    // count as one qualified listen. The event itself still preserves whether
    // the exit was a completion or a skip for recommendation training.
    const qualifiedListen = action === "play" || action === "complete" ||
      (action === "skip" && (playedRatio ?? 0) >= 0.5);
    if (qualifiedListen) {
      db.prepare(`
        UPDATE tracks
        SET play_count = COALESCE(play_count, 0) + 1,
            last_played_at = unixepoch(),
            updated_at = unixepoch()
        WHERE id = $id
      `).run({ $id: trackId });
    }
    return true;
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

export function getPlaylists(userId?: string | null): Record<string, unknown>[] {
  const db = getDb();
  const userClause = userId ? "WHERE (p.user_id = $uid OR p.user_id IS NULL)" : "";
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
    ${userClause}
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `).all(userId ? { $uid: userId } : {}) as Record<string, unknown>[];

  return rows.map(normalizePlaylistRow);
}

export function createPlaylist(id: string, name: string, description?: string, userId?: string | null): void {
  const db = getDb();
  db.prepare("INSERT INTO playlists (id, name, description, user_id) VALUES ($id, $name, $desc, $uid)")
    .run({ $id: id, $name: name, $desc: description ?? null, $uid: userId ?? null });
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

/**
 * For tests only — replace the db singleton so tests can use an in-memory DB.
 * Pass null to reset (forces next getDb() call to re-open from DB_PATH).
 */
export function setDbForTest(db: Database | null): void {
  _db = db;
  _configSecret = null;
}
