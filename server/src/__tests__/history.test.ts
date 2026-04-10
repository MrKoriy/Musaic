/**
 * History endpoint tests
 *
 * Tests POST /api/history — action validation, track-id requirement,
 * and play count side-effects.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { setupTestDb, teardownTestDb, seedTrack } from "./setup.js";
import { logListening, getDb } from "../db/index.js";

/** Minimal history route, mirroring the one in index.ts */
function buildApp() {
  const app = new Hono();
  app.post("/api/history", async (c) => {
    const body = await c.req.json<{ trackId: string; action: string }>();
    if (!body.trackId || !body.action) {
      return c.json({ error: "trackId and action required" }, 400);
    }
    const validActions = new Set(["play", "pause", "skip", "like", "dislike", "complete"]);
    if (!validActions.has(body.action)) {
      return c.json({ error: "Invalid action" }, 400);
    }
    logListening(body.trackId, body.action, undefined);
    return c.json({ ok: true });
  });
  return app;
}

describe("POST /api/history", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("accepts valid play action", async () => {
    const trackId = seedTrack();
    const res = await buildApp().request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId, action: "play" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("accepts all valid actions", async () => {
    const trackId = seedTrack();
    const actions = ["play", "pause", "skip", "like", "dislike", "complete"];
    for (const action of actions) {
      const res = await buildApp().request("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId, action }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("rejects invalid action", async () => {
    const trackId = seedTrack();
    const res = await buildApp().request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId, action: "unknown_action" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid action/i);
  });

  it("rejects missing trackId", async () => {
    const res = await buildApp().request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "play" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing action", async () => {
    const trackId = seedTrack();
    const res = await buildApp().request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId }),
    });
    expect(res.status).toBe(400);
  });

  it("increments play_count on play action", async () => {
    const trackId = seedTrack();
    const db = getDb();

    const before = db.prepare("SELECT play_count FROM tracks WHERE id = $id").get({ $id: trackId }) as { play_count: number };
    expect(before.play_count).toBe(0);

    await buildApp().request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId, action: "play" }),
    });

    const after = db.prepare("SELECT play_count FROM tracks WHERE id = $id").get({ $id: trackId }) as { play_count: number };
    expect(after.play_count).toBe(1);
  });

  it("does not increment play_count on non-play actions", async () => {
    const trackId = seedTrack();
    const db = getDb();

    await buildApp().request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId, action: "skip" }),
    });

    const row = db.prepare("SELECT play_count FROM tracks WHERE id = $id").get({ $id: trackId }) as { play_count: number };
    expect(row.play_count).toBe(0);
  });

  it("records only one play when duplicate events fire within 5s", async () => {
    const trackId = seedTrack();
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      await app.request("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId, action: "play" }),
      });
    }
    const db = getDb();
    const count = db.prepare("SELECT COUNT(*) as n FROM listening_history WHERE track_id = $id AND action = 'play'").get({ $id: trackId }) as { n: number };
    expect(count.n).toBe(1);
  });

  it("dedup: play_count increments only once for rapid duplicate plays", async () => {
    const trackId = seedTrack();
    const app = buildApp();
    const db = getDb();

    for (let i = 0; i < 3; i++) {
      await app.request("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId, action: "play" }),
      });
    }

    const row = db.prepare("SELECT play_count FROM tracks WHERE id = $id").get({ $id: trackId }) as { play_count: number };
    expect(row.play_count).toBe(1);
  });

  it("dedup: different actions for same track are each recorded", async () => {
    const trackId = seedTrack();
    const app = buildApp();
    const db = getDb();

    await app.request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId, action: "play" }),
    });
    await app.request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId, action: "pause" }),
    });

    const count = db.prepare("SELECT COUNT(*) as n FROM listening_history WHERE track_id = $id").get({ $id: trackId }) as { n: number };
    expect(count.n).toBe(2);
  });

  it("dedup: different tracks with same action are each recorded", async () => {
    const trackId1 = seedTrack();
    const trackId2 = seedTrack();
    const app = buildApp();
    const db = getDb();

    await app.request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: trackId1, action: "play" }),
    });
    await app.request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: trackId2, action: "play" }),
    });

    const count = db.prepare("SELECT COUNT(*) as n FROM listening_history WHERE action = 'play'").get() as { n: number };
    expect(count.n).toBe(2);
  });
});
