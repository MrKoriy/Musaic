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

const configuredSessionDays = Number(process.env.SESSION_TTL_DAYS ?? 90);
const SESSION_TTL_SECONDS = Math.floor(
  (Number.isFinite(configuredSessionDays) && configuredSessionDays > 0 ? configuredSessionDays : 90) * 24 * 60 * 60,
);

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
  {
    version: 9,
    description: "Add rich playback telemetry and separate unlike from dislike",
    up: `
      CREATE TABLE listening_history_v9 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        track_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('play', 'pause', 'skip', 'like', 'unlike', 'dislike', 'complete')),
        played_at INTEGER NOT NULL DEFAULT (unixepoch()),
        user_id TEXT REFERENCES users(id),
        played_ms INTEGER,
        duration_ms INTEGER,
        played_ratio REAL,
        session_id TEXT,
        request_id TEXT,
        surface TEXT,
        is_organic INTEGER NOT NULL DEFAULT 1,
        position INTEGER,
        context TEXT
      );

      INSERT INTO listening_history_v9 (id, track_id, action, played_at, user_id)
      SELECT id, track_id, action, played_at, user_id
      FROM listening_history;

      DROP TABLE listening_history;
      ALTER TABLE listening_history_v9 RENAME TO listening_history;

      CREATE UNIQUE INDEX idx_lh_event_id ON listening_history(event_id) WHERE event_id IS NOT NULL;
      CREATE INDEX idx_lh_action_played_at ON listening_history(action, played_at);
      CREATE INDEX idx_lh_track_id ON listening_history(track_id);
      CREATE INDEX idx_lh_track_played ON listening_history(track_id, played_at);
      CREATE INDEX idx_lh_user_id ON listening_history(user_id);
      CREATE INDEX idx_lh_user_played ON listening_history(user_id, played_at);
      CREATE INDEX idx_lh_action_played ON listening_history(action, played_at);
      CREATE INDEX idx_lh_user_surface_played ON listening_history(user_id, surface, played_at);
    `,
  },
  {
    version: 10,
    description: "Track recommendation impressions for offline quality evaluation",
    up: `
      CREATE TABLE recommendation_impressions (
        request_id TEXT NOT NULL,
        user_id TEXT REFERENCES users(id),
        surface TEXT NOT NULL,
        track_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (request_id, track_id)
      );
      CREATE INDEX idx_ri_user_surface_created
        ON recommendation_impressions(user_id, surface, created_at);
      CREATE INDEX idx_ri_track_created
        ON recommendation_impressions(track_id, created_at);
    `,
  },
  {
    version: 11,
    description: "Persist versioned per-user Daily Mix snapshots",
    up: `
      CREATE TABLE IF NOT EXISTS daily_mix_snapshots (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        local_date TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        theme_id TEXT NOT NULL DEFAULT 'default',
        theme_name TEXT NOT NULL DEFAULT 'Daily Mix',
        revision INTEGER NOT NULL DEFAULT 1,
        request_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'daily_mix',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user_key, local_date, algorithm_version, theme_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_mix_snapshot_lookup
        ON daily_mix_snapshots(user_key, local_date, algorithm_version, theme_id, revision DESC);

      CREATE TABLE IF NOT EXISTS daily_mix_snapshot_items (
        snapshot_id TEXT NOT NULL REFERENCES daily_mix_snapshots(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        position INTEGER NOT NULL,
        score REAL,
        reason TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, position),
        UNIQUE(snapshot_id, canonical_key)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_mix_items_track
        ON daily_mix_snapshot_items(track_id);
    `,
  },
  {
    version: 12,
    description: "Add recommendation graph, tag, model, job, and shadow-ranking tables",
    up: `
      CREATE TABLE IF NOT EXISTS related_artists (
        artist_key TEXT NOT NULL,
        related_key TEXT NOT NULL,
        score REAL NOT NULL,
        source TEXT NOT NULL DEFAULT 'lastfm',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (artist_key, related_key, source)
      );
      CREATE INDEX IF NOT EXISTS idx_related_artists_key
        ON related_artists(artist_key, score DESC);

      CREATE TABLE IF NOT EXISTS track_tags (
        track_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        weight REAL NOT NULL,
        source TEXT NOT NULL DEFAULT 'lastfm',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (track_id, tag, source)
      );
      CREATE INDEX IF NOT EXISTS idx_track_tags_tag
        ON track_tags(tag, weight DESC);
      CREATE INDEX IF NOT EXISTS idx_track_tags_track
        ON track_tags(track_id, weight DESC);

      CREATE TABLE IF NOT EXISTS similar_items (
        track_id TEXT NOT NULL,
        other_id TEXT NOT NULL,
        score REAL NOT NULL,
        source TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (track_id, other_id, source)
      );
      CREATE INDEX IF NOT EXISTS idx_similar_items_track
        ON similar_items(track_id, score DESC);
      CREATE INDEX IF NOT EXISTS idx_similar_items_other
        ON similar_items(other_id, score DESC);

      CREATE TABLE IF NOT EXISTS reco_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL UNIQUE,
        trained_at INTEGER NOT NULL DEFAULT (unixepoch()),
        impressions_used INTEGER NOT NULL DEFAULT 0,
        auc REAL NOT NULL DEFAULT 0,
        weights_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_state (
        name TEXT PRIMARY KEY,
        last_run_at INTEGER,
        last_status TEXT,
        last_error TEXT
      );

      ALTER TABLE recommendation_impressions ADD COLUMN hand_score REAL;
      ALTER TABLE recommendation_impressions ADD COLUMN model_score REAL;
      ALTER TABLE recommendation_impressions ADD COLUMN model_version TEXT;
      ALTER TABLE recommendation_impressions ADD COLUMN reco_variant TEXT;
    `,
  },
  {
    version: 13,
    description: "Add recommendation settings and optional audio embeddings",
    up: `
      CREATE TABLE IF NOT EXISTS reco_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS audio_embeddings (
        track_id TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_audio_embeddings_updated
        ON audio_embeddings(updated_at);
    `,
  },
  {
    version: 14,
    description: "Persist recommendation feature vectors for ranker training",
    up: `
      ALTER TABLE recommendation_impressions ADD COLUMN features_json TEXT;
    `,
  },
  {
    version: 15,
    description: "Add expiring sessions and remove legacy user tokens",
    up: `
      ALTER TABLE sessions ADD COLUMN expires_at INTEGER;
      INSERT OR IGNORE INTO sessions (token, user_id, device_name, expires_at)
        SELECT token, id, 'legacy', unixepoch() + ${SESSION_TTL_SECONDS}
        FROM users
        WHERE token IS NOT NULL;
      UPDATE sessions
      SET expires_at = COALESCE(expires_at, created_at + ${SESSION_TTL_SECONDS});
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
      UPDATE users SET token = NULL WHERE token IS NOT NULL;
    `,
  },
  {
    version: 16,
    description: "Move provider credentials into provider_config",
    up: `
      CREATE TABLE IF NOT EXISTS vk_config (
        id INTEGER PRIMARY KEY CHECK(id IN (1, 2)),
        username TEXT,
        password_enc TEXT,
        token TEXT,
        token_expiry INTEGER,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS provider_config (
        provider TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(provider, key)
      );
      INSERT OR IGNORE INTO provider_config (provider, key, value)
        SELECT 'vk', 'username', username FROM vk_config
        WHERE id = 1 AND username IS NOT NULL;
      INSERT OR IGNORE INTO provider_config (provider, key, value)
        SELECT 'vk', 'token', token FROM vk_config
        WHERE id = 1 AND token IS NOT NULL;
      INSERT OR IGNORE INTO provider_config (provider, key, value)
        SELECT 'vk', 'token_expiry', CAST(token_expiry AS TEXT) FROM vk_config
        WHERE id = 1 AND token_expiry IS NOT NULL;
      INSERT OR IGNORE INTO provider_config (provider, key, value)
        SELECT 'soundcloud', 'client_id', token FROM vk_config
        WHERE id = 2 AND token IS NOT NULL;
      INSERT OR IGNORE INTO provider_config (provider, key, value)
        SELECT 'soundcloud', 'client_id_fetched_at',
          CAST(token_expiry - (4 * 60 * 60 * 1000) AS TEXT)
        FROM vk_config
        WHERE id = 2 AND token IS NOT NULL AND token_expiry IS NOT NULL;
      DROP TABLE IF EXISTS vk_config;
    `,
  },
  {
    version: 17,
    description: "Add job leases and cover file references",
    up: `
      ALTER TABLE job_state ADD COLUMN started_at INTEGER;
      ALTER TABLE job_state ADD COLUMN heartbeat INTEGER;
      ALTER TABLE job_state ADD COLUMN instance_id TEXT;
      ALTER TABLE tracks ADD COLUMN cover_path TEXT;
      ALTER TABLE playlist_cover_data ADD COLUMN file_path TEXT;
    `,
  },
  {
    version: 18,
    description: "Persist ranker baseline and precision metrics",
    up: `
      ALTER TABLE reco_models ADD COLUMN baseline_auc REAL NOT NULL DEFAULT 0;
      ALTER TABLE reco_models ADD COLUMN precision_at_5 REAL NOT NULL DEFAULT 0;
      ALTER TABLE reco_models ADD COLUMN precision_at_10 REAL NOT NULL DEFAULT 0;
      ALTER TABLE reco_models ADD COLUMN baseline_precision_at_5 REAL NOT NULL DEFAULT 0;
      ALTER TABLE reco_models ADD COLUMN baseline_precision_at_10 REAL NOT NULL DEFAULT 0;
      ALTER TABLE reco_models ADD COLUMN evaluation_method TEXT NOT NULL DEFAULT 'legacy';
    `,
  },
  {
    version: 19,
    description: "Track archived listening-history events",
    up: `
      CREATE TABLE IF NOT EXISTS retention_archive_events (
        event_id INTEGER PRIMARY KEY,
        archived_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
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
