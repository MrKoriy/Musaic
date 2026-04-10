/**
 * Track listing endpoint tests
 *
 * Tests GET /api/tracks and GET /api/tracks/by-ids
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { setupTestDb, teardownTestDb, seedTrack } from "./setup.js";
import { getDb } from "../db/index.js";

function buildApp() {
  const app = new Hono();

  app.get("/api/tracks", (c) => {
    const db = getDb();
    const source = c.req.query("source");
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
    const offset = Number(c.req.query("offset") ?? 0);
    const rows = source
      ? db.prepare("SELECT * FROM tracks WHERE source = $s LIMIT $l OFFSET $o").all({ $s: source, $l: limit, $o: offset })
      : db.prepare("SELECT * FROM tracks LIMIT $l OFFSET $o").all({ $l: limit, $o: offset });
    return c.json({ tracks: rows });
  });

  app.get("/api/tracks/by-ids", (c) => {
    const db = getDb();
    const ids = (c.req.query("ids") ?? "")
      .split(",")
      .map((v) => decodeURIComponent(v).trim())
      .filter(Boolean)
      .slice(0, 500);
    if (ids.length === 0) return c.json({ tracks: [] });
    const uniqueIDs = Array.from(new Set(ids));
    const placeholders = uniqueIDs.map((_, i) => `$id${i}`).join(", ");
    const params = Object.fromEntries(uniqueIDs.map((id, i) => [`$id${i}`, id]));
    const rows = db.prepare(`SELECT * FROM tracks WHERE id IN (${placeholders})`).all(params) as Array<Record<string, unknown> & { id: string }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return c.json({ tracks: uniqueIDs.map((id) => byId.get(id)).filter(Boolean) });
  });

  return app;
}

describe("Tracks API", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  // ── GET /api/tracks ────────────────────────────────────────────────────────

  it("returns empty array when no tracks", async () => {
    const res = await buildApp().request("/api/tracks");
    expect(res.status).toBe(200);
    const body = await res.json() as { tracks: unknown[] };
    expect(body.tracks).toHaveLength(0);
  });

  it("returns all seeded tracks", async () => {
    seedTrack({ title: "Alpha" });
    seedTrack({ title: "Beta" });
    const res = await buildApp().request("/api/tracks");
    const body = await res.json() as { tracks: { title: string }[] };
    expect(body.tracks).toHaveLength(2);
    const titles = body.tracks.map((t) => t.title).sort();
    expect(titles).toEqual(["Alpha", "Beta"]);
  });

  it("filters by source", async () => {
    seedTrack({ source: "local", title: "Local Track" });
    seedTrack({ source: "soundcloud", title: "SC Track" });

    const res = await buildApp().request("/api/tracks?source=local");
    const body = await res.json() as { tracks: { title: string }[] };
    expect(body.tracks).toHaveLength(1);
    expect(body.tracks[0].title).toBe("Local Track");
  });

  it("respects limit and offset", async () => {
    for (let i = 0; i < 5; i++) seedTrack({ title: `Track ${i}` });

    const res1 = await buildApp().request("/api/tracks?limit=2&offset=0");
    const body1 = await res1.json() as { tracks: unknown[] };
    expect(body1.tracks).toHaveLength(2);

    const res2 = await buildApp().request("/api/tracks?limit=2&offset=2");
    const body2 = await res2.json() as { tracks: unknown[] };
    expect(body2.tracks).toHaveLength(2);
  });

  // ── GET /api/tracks/by-ids ─────────────────────────────────────────────────

  it("returns empty when ids is empty", async () => {
    const res = await buildApp().request("/api/tracks/by-ids?ids=");
    const body = await res.json() as { tracks: unknown[] };
    expect(body.tracks).toHaveLength(0);
  });

  it("fetches tracks by ids", async () => {
    const id1 = seedTrack({ title: "Song One" });
    const id2 = seedTrack({ title: "Song Two" });
    seedTrack({ title: "Song Three" }); // not requested

    const res = await buildApp().request(`/api/tracks/by-ids?ids=${id1},${id2}`);
    const body = await res.json() as { tracks: { title: string }[] };
    expect(body.tracks).toHaveLength(2);
    const titles = body.tracks.map((t) => t.title).sort();
    expect(titles).toEqual(["Song One", "Song Two"]);
  });

  it("deduplicates repeated ids", async () => {
    const id = seedTrack({ title: "Dupe" });
    const res = await buildApp().request(`/api/tracks/by-ids?ids=${id},${id},${id}`);
    const body = await res.json() as { tracks: unknown[] };
    expect(body.tracks).toHaveLength(1);
  });

  it("returns only found tracks (ignores unknown ids)", async () => {
    const id = seedTrack({ title: "Real Track" });
    const res = await buildApp().request(`/api/tracks/by-ids?ids=${id},nonexistent_id`);
    const body = await res.json() as { tracks: { title: string }[] };
    expect(body.tracks).toHaveLength(1);
    expect(body.tracks[0].title).toBe("Real Track");
  });
});
