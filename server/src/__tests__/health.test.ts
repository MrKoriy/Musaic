/**
 * Health check endpoint tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { setupTestDb, teardownTestDb } from "./setup.js";
import { getDb } from "../db/index.js";

function buildApp() {
  const app = new Hono();
  app.get("/health", (c) => {
    let dbOk = false;
    let trackCount = 0;
    try {
      const db = getDb();
      db.prepare("SELECT 1").get();
      trackCount = (db.prepare("SELECT COUNT(*) as n FROM tracks").get() as { n: number }).n;
      dbOk = true;
    } catch { /* ignore */ }
    return c.json({ ok: dbOk, db: { ok: dbOk, trackCount } });
  });
  return app;
}

describe("GET /health", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("returns ok=true with empty DB", async () => {
    const app = buildApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; db: { ok: boolean; trackCount: number } };
    expect(body.ok).toBe(true);
    expect(body.db.ok).toBe(true);
    expect(body.db.trackCount).toBe(0);
  });

  it("reflects track count in DB", async () => {
    const db = getDb();
    db.prepare("INSERT INTO tracks (id, source, title, artist, duration) VALUES ('t1', 'local', 'Song', 'Artist', 180)").run();
    db.prepare("INSERT INTO tracks (id, source, title, artist, duration) VALUES ('t2', 'local', 'Song2', 'Artist', 200)").run();

    const app = buildApp();
    const res = await app.request("/health");
    const body = await res.json() as { db: { trackCount: number } };
    expect(body.db.trackCount).toBe(2);
  });
});
