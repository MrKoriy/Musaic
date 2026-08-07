/**
 * Test setup helpers — creates an isolated in-memory SQLite DB for each test suite.
 *
 * Usage in each test file:
 *   import { setupTestDb, teardownTestDb, seedTrack } from "./setup.js";
 *   beforeEach(setupTestDb);
 *   afterEach(teardownTestDb);
 */

import { Database } from "bun:sqlite";
import { setDbForTest, getDb } from "../db/index.js";
import { runMigrations } from "../db/migrations.js";

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
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
      played_at INTEGER NOT NULL DEFAULT (unixepoch()),
      user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      user_id TEXT,
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

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      token TEXT UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_used_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS liked_tracks (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL,
      liked_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, track_id)
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
  `);

  runMigrations(db);
}

/** Creates a fresh in-memory DB and wires it into the module singleton. */
export function setupTestDb(): void {
  const db = new Database(":memory:", { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  createSchema(db);
  setDbForTest(db);
}

/** Resets the DB singleton so the next test gets a clean slate. */
export function teardownTestDb(): void {
  setDbForTest(null);
}

/** Inserts a minimal test track and returns its id. */
export function seedTrack(opts: {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  source?: "local" | "vk" | "soundcloud" | "yandex" | "youtube";
  duration?: number;
} = {}): string {
  const db = getDb();
  const id = opts.id ?? `test_track_${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO tracks (id, source, title, artist, album, duration)
    VALUES ($id, $source, $title, $artist, $album, $duration)
  `).run({
    $id: id,
    $source: opts.source ?? "local",
    $title: opts.title ?? "Test Track",
    $artist: opts.artist ?? "Test Artist",
    $album: opts.album ?? "Test Album",
    $duration: opts.duration ?? 180,
  });
  return id;
}

/** Logs a play event for a track directly in the DB. */
export function seedPlay(trackId: string, userId?: string): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO listening_history (track_id, action, user_id) VALUES ($id, 'play', $uid)"
  ).run({ $id: trackId, $uid: userId ?? null });
}
