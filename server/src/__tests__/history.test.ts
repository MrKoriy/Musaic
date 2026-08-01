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
    const body = await c.req.json<{
      trackId: string;
      action: string;
      eventId?: string;
      playedMs?: number;
      durationMs?: number;
      playedRatio?: number;
      sessionId?: string;
      surface?: string;
      isOrganic?: boolean;
    }>();
    if (!body.trackId || !body.action) {
      return c.json({ error: "trackId and action required" }, 400);
    }
    const validActions = new Set(["play", "pause", "skip", "like", "unlike", "dislike", "complete"]);
    if (!validActions.has(body.action)) {
      return c.json({ error: "Invalid action" }, 400);
    }
    logListening(body.trackId, body.action, undefined, body);
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
    const actions = ["play", "pause", "skip", "like", "unlike", "dislike", "complete"];
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

  it("stores playback ratio and recommendation context", async () => {
    const trackId = seedTrack({ duration: 200 });
    await buildApp().request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trackId,
        action: "skip",
        eventId: "event-rich-1",
        playedMs: 150_000,
        durationMs: 200_000,
        sessionId: "session-1",
        surface: "my_vibe",
        isOrganic: false,
      }),
    });

    const row = getDb().prepare(`
      SELECT event_id, played_ratio, session_id, surface, is_organic
      FROM listening_history WHERE track_id = $id
    `).get({ $id: trackId }) as {
      event_id: string;
      played_ratio: number;
      session_id: string;
      surface: string;
      is_organic: number;
    };
    expect(row.event_id).toBe("event-rich-1");
    expect(row.played_ratio).toBeCloseTo(0.75, 5);
    expect(row.session_id).toBe("session-1");
    expect(row.surface).toBe("my_vibe");
    expect(row.is_organic).toBe(0);
  });

  it("deduplicates retried events by stable event id", async () => {
    const trackId = seedTrack();
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      await app.request("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId, action: "complete", eventId: "same-event-id" }),
      });
    }

    const count = getDb().prepare(
      "SELECT COUNT(*) AS n FROM listening_history WHERE event_id = 'same-event-id'"
    ).get() as { n: number };
    const track = getDb().prepare("SELECT play_count FROM tracks WHERE id = $id")
      .get({ $id: trackId }) as { play_count: number };
    expect(count.n).toBe(1);
    expect(track.play_count).toBe(1);
  });

  it("counts a late manual skip as a qualified listen only once", () => {
    const trackId = seedTrack();
    logListening(trackId, "skip", null, {
      eventId: "late-skip",
      playedMs: 120_000,
      durationMs: 180_000,
    });
    const track = getDb().prepare("SELECT play_count FROM tracks WHERE id = $id")
      .get({ $id: trackId }) as { play_count: number };
    expect(track.play_count).toBe(1);
  });

  it("normalizes a completion without duration telemetry to a full listen", async () => {
    const trackId = seedTrack();
    await buildApp().request("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId, action: "complete", eventId: "completion-without-duration" }),
    });

    const row = getDb().prepare(`
      SELECT played_ratio FROM listening_history WHERE event_id = 'completion-without-duration'
    `).get() as { played_ratio: number };
    expect(row.played_ratio).toBe(1);
  });
});
