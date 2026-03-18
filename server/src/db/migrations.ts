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
