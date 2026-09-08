import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../db/migrations";
import { createSchema } from "./setup";

function tempDbDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "musaic-mig-test-"));
}

describe("pre-migration snapshots", () => {
  test("creates a snapshot next to a file-backed DB before migrating", () => {
    const dir = tempDbDir();
    const dbPath = path.join(dir, "test.db");
    process.env.DB_PATH = dbPath;
    try {
      const db = new Database(dbPath, { create: true });
      createSchema(db); // applies initial schema + migrations; snapshot happens on first runMigrations

      const snapshots = fs.readdirSync(dir)
        .filter((name) => /^pre-migration-v\d+-.*\.db$/.test(name));
      expect(snapshots.length).toBeGreaterThan(0);

      const snapshot = new Database(path.join(dir, snapshots[0]!), { readonly: true });
      const applied = snapshot.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
      expect(applied.n).toBe(0); // snapshot captured before any migration was recorded
      snapshot.close();
      db.close();
    } finally {
      delete process.env.DB_PATH;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips snapshots for in-memory databases", () => {
    const db = new Database(":memory:", { create: true });
    createSchema(db); // must not throw or write snapshots to cwd
    const applied = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(applied.n).toBeGreaterThan(0);
    db.close();
  });
});
