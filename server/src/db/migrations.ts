/**
 * DB Migration system — version tracking with up/down scripts.
 *
 * Creates a `schema_migrations` table to track applied migrations.
 * Migrations are applied in order on startup.
 *
 * To add a new migration:
 *   1. Append to the MIGRATIONS array with the next version number.
 *   2. Provide `up` SQL (and optionally `down` SQL for rollback).
 *
 * Usage:
 *   import { runMigrations } from './migrations.js';
 *   runMigrations(db);
 */

import type { Database } from "bun:sqlite";

interface Migration {
  version: number;
  description: string;
  up: string;
  down?: string;
}

/**
 * All migrations in order.
 * Version 0 = the initial schema (created by initSchema in db/index.ts).
 * Start new migrations at version 1.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Add mood and genre columns to tracks",
    up: `
      ALTER TABLE tracks ADD COLUMN mood TEXT;
      ALTER TABLE tracks ADD COLUMN genre TEXT;
    `,
    down: `
      -- SQLite doesn't support DROP COLUMN in older versions; migration is irreversible
    `,
  },
  {
    version: 2,
    description: "Add play_count and last_played_at to tracks",
    up: `
      ALTER TABLE tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracks ADD COLUMN last_played_at INTEGER;
    `,
  },
  {
    version: 3,
    description: "Create sc_metadata cache table",
    up: `
      CREATE TABLE IF NOT EXISTS sc_metadata_cache (
        track_id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL,
        fetched_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `,
  },
  {
    version: 4,
    description: "Create playlist_cover_data table",
    up: `
      CREATE TABLE IF NOT EXISTS playlist_cover_data (
        playlist_id TEXT PRIMARY KEY REFERENCES playlists(id) ON DELETE CASCADE,
        data BLOB NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `,
  },
  {
    version: 5,
    description: "Add users table and user_id columns for multi-user support",
    up: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT,
        password_hash TEXT NOT NULL,
        token TEXT UNIQUE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_seen_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

      ALTER TABLE listening_history ADD COLUMN user_id TEXT REFERENCES users(id);
      ALTER TABLE playlists ADD COLUMN user_id TEXT REFERENCES users(id);

      CREATE INDEX IF NOT EXISTS idx_lh_user_id ON listening_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id);
    `,
  },
  {
    version: 6,
    description: "Add sessions table for multi-device auth + liked_tracks table for sync",
    up: `
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_used_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS liked_tracks (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL,
        liked_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (user_id, track_id)
      );

      INSERT OR IGNORE INTO sessions (token, user_id, device_name)
        SELECT token, id, 'legacy' FROM users WHERE token IS NOT NULL;
    `,
  },
  {
    version: 7,
    description: "Add composite indexes for stats and listening history queries",
    up: `
      CREATE INDEX IF NOT EXISTS idx_lh_user_played ON listening_history(user_id, played_at);
      CREATE INDEX IF NOT EXISTS idx_lh_action_played ON listening_history(action, played_at);
      CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(album, artist);
    `,
  },
  {
    version: 8,
    description: "Backfill legacy anonymous likes for single-user installs",
    up: `
      INSERT OR IGNORE INTO liked_tracks (user_id, track_id, liked_at)
      SELECT u.id, legacy.track_id, legacy.liked_at
      FROM users u
      JOIN (
        SELECT track_id, MAX(played_at) AS liked_at
        FROM listening_history
        WHERE user_id IS NULL AND action = 'like'
        GROUP BY track_id
      ) legacy
      WHERE (SELECT COUNT(*) FROM users) = 1;
    `,
  },
];

/**
 * Run all pending migrations against the given database.
 * Safe to call on every startup — skips already-applied migrations.
 */
export function runMigrations(db: Database): void {
  // Create migration tracking table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const applied = new Set<number>(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[])
      .map((r) => r.version)
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    return; // Nothing to do
  }

  console.log(`[migrations] Applying ${pending.length} pending migration(s)...`);

  for (const migration of pending) {
    try {
      db.exec("BEGIN");

      // Some migrations may contain multiple statements (ALTER TABLE, etc.)
      // SQLite doesn't support multi-statement exec with bindings, but exec() handles it
      const statements = migration.up
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const stmt of statements) {
        try {
          db.exec(stmt);
        } catch (err: unknown) {
          // ALTER TABLE ADD COLUMN fails if column already exists — treat as no-op
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("duplicate column name")) {
            console.warn(`[migrations] v${migration.version}: column already exists (skipping): ${msg}`);
          } else {
            throw err;
          }
        }
      }

      db.prepare(
        "INSERT INTO schema_migrations (version, description) VALUES ($v, $d)"
      ).run({ $v: migration.version, $d: migration.description });

      db.exec("COMMIT");
      console.log(`[migrations] ✓ v${migration.version}: ${migration.description}`);
    } catch (err: unknown) {
      db.exec("ROLLBACK");
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[migrations] ✗ v${migration.version} FAILED: ${msg}`);
      throw new Error(`Migration v${migration.version} failed: ${msg}`);
    }
  }

  console.log(`[migrations] All migrations applied.`);
}

/**
 * Get list of applied migration versions.
 */
export function getAppliedMigrations(db: Database): { version: number; description: string; applied_at: number }[] {
  return db
    .prepare("SELECT version, description, applied_at FROM schema_migrations ORDER BY version")
    .all() as { version: number; description: string; applied_at: number }[];
}
