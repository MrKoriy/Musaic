import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import authRoutes from "../routes/auth.js";
import { getDb } from "../db/index.js";
import { setupTestDb, teardownTestDb } from "./setup.js";

function buildApp() {
  const app = new Hono();

  app.use("/api/auth/*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice(7).trim();
      const db = getDb();
      const user = db.prepare(`
        SELECT u.id, u.username FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = $token
      `).get({ $token: token }) as { id: string; username: string } | null;
      if (user) {
        (c as any).set("userId", user.id);
        (c as any).set("username", user.username);
      }
    }
    return next();
  });

  app.route("/api/auth", authRoutes);
  return app;
}

async function register(app: Hono): Promise<string> {
  const username = `user_${Math.random().toString(36).slice(2)}`;
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123", displayName: "Test User" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { token: string };
  return body.token;
}

function userIdForToken(token: string): string {
  const row = getDb().prepare("SELECT user_id FROM sessions WHERE token = $token")
    .get({ $token: token }) as { user_id: string } | null;
  if (!row) throw new Error("Test session not found");
  return row.user_id;
}

describe("Auth likes sync", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("sets likes idempotently without toggling stale device state", async () => {
    const app = buildApp();
    const token = await register(app);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    for (let i = 0; i < 2; i++) {
      const res = await app.request("/api/auth/likes/set", {
        method: "POST",
        headers,
        body: JSON.stringify({ trackId: "sc_1", liked: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ trackId: "sc_1", liked: true });
    }

    const db = getDb();
    const likedCount = db.prepare("SELECT COUNT(*) as n FROM liked_tracks WHERE track_id = 'sc_1'")
      .get() as { n: number };
    expect(likedCount.n).toBe(1);

    const unlikeRes = await app.request("/api/auth/likes/set", {
      method: "POST",
      headers,
      body: JSON.stringify({ trackId: "sc_1", liked: false }),
    });
    expect(unlikeRes.status).toBe(200);

    const remaining = db.prepare("SELECT COUNT(*) as n FROM liked_tracks WHERE track_id = 'sc_1'")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("sync merges client likes and stores provided track metadata", async () => {
    const app = buildApp();
    const token = await register(app);

    const res = await app.request("/api/auth/likes/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        trackIds: ["sc_42"],
        tracks: [{
          id: "sc_42",
          source: "soundcloud",
          title: "Remote Song",
          artist: "Remote Artist",
          album: "Remote Album",
          duration: 123,
          coverUrl: "https://example.com/cover.jpg",
        }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { trackIds: string[]; count: number };
    expect(body.trackIds).toEqual(["sc_42"]);
    expect(body.count).toBe(1);

    const track = getDb().prepare("SELECT source, title, artist, album, duration, cover_url FROM tracks WHERE id = 'sc_42'")
      .get() as { source: string; title: string; artist: string; album: string; duration: number; cover_url: string } | null;
    expect(track).toEqual({
      source: "soundcloud",
      title: "Remote Song",
      artist: "Remote Artist",
      album: "Remote Album",
      duration: 123,
      cover_url: "https://example.com/cover.jpg",
    });
  });

  it("sync applies offline unlike tombstones without deleting unrelated likes", async () => {
    const app = buildApp();
    const token = await register(app);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    await app.request("/api/auth/likes/sync", {
      method: "POST",
      headers,
      body: JSON.stringify({ trackIds: ["keep", "remove"] }),
    });
    const response = await app.request("/api/auth/likes/sync", {
      method: "POST",
      headers,
      body: JSON.stringify({ trackIds: ["keep"], removedTrackIds: ["remove"] }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { trackIds: string[] };
    expect(body.trackIds).toEqual(["keep"]);
  });

  it("legacy toggle honors recent like/dislike history intent", async () => {
    const app = buildApp();
    const token = await register(app);
    const userId = userIdForToken(token);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const db = getDb();

    db.prepare("INSERT INTO listening_history (track_id, action, user_id) VALUES ($tid, 'like', $uid)")
      .run({ $tid: "legacy_track", $uid: userId });

    for (let i = 0; i < 2; i++) {
      const res = await app.request("/api/auth/likes/toggle", {
        method: "POST",
        headers,
        body: JSON.stringify({ trackId: "legacy_track" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ trackId: "legacy_track", liked: true });
    }

    const likedCount = db.prepare("SELECT COUNT(*) as n FROM liked_tracks WHERE user_id = $uid AND track_id = 'legacy_track'")
      .get({ $uid: userId }) as { n: number };
    expect(likedCount.n).toBe(1);

    db.prepare("INSERT INTO listening_history (track_id, action, user_id) VALUES ($tid, 'dislike', $uid)")
      .run({ $tid: "legacy_track", $uid: userId });

    const dislikeRes = await app.request("/api/auth/likes/toggle", {
      method: "POST",
      headers,
      body: JSON.stringify({ trackId: "legacy_track" }),
    });
    expect(dislikeRes.status).toBe(200);
    expect(await dislikeRes.json()).toMatchObject({ trackId: "legacy_track", liked: false });

    const remaining = db.prepare("SELECT COUNT(*) as n FROM liked_tracks WHERE user_id = $uid AND track_id = 'legacy_track'")
      .get({ $uid: userId }) as { n: number };
    expect(remaining.n).toBe(0);
  });
});
