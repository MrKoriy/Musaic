/**
 * Auth Routes — user registration, login, profile
 *
 * POST /api/auth/register  — create account
 * POST /api/auth/login     — get token
 * GET  /api/auth/me        — current user info
 */

import { Hono } from "hono";
import crypto from "crypto";
import { getDb, upsertTrack } from "../db/index.js";

const router = new Hono();

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt ?? crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, s, 64).toString("hex");
  return { hash: `${s}:${hash}`, salt: s };
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const { hash: computed } = hashPassword(password, salt);
  return computed === stored;
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// POST /api/auth/register
router.post("/register", async (c) => {
  const body = await c.req.json<{ username?: string; password?: string; displayName?: string }>();
  const username = body.username?.trim();
  const password = body.password;
  const displayName = body.displayName?.trim() || username;

  if (!username || username.length < 2 || username.length > 30) {
    return c.json({ error: "Username must be 2-30 characters" }, 400);
  }
  if (!password || password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return c.json({ error: "Username can only contain letters, numbers, dots, dashes, underscores" }, 400);
  }

  const db = getDb();

  const existing = db.prepare("SELECT id FROM users WHERE username = $u COLLATE NOCASE").get({ $u: username });
  if (existing) {
    return c.json({ error: "Username already taken" }, 409);
  }

  const id = crypto.randomUUID();
  const { hash } = hashPassword(password);
  const token = generateToken();

  db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash)
    VALUES ($id, $username, $display_name, $hash)
  `).run({ $id: id, $username: username, $display_name: displayName ?? username, $hash: hash });

  db.prepare("INSERT INTO sessions (token, user_id) VALUES ($token, $uid)")
    .run({ $token: token, $uid: id });

  return c.json({
    ok: true,
    user: { id, username, displayName },
    token,
  });
});

// POST /api/auth/login
router.post("/login", async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>();
  const username = body.username?.trim();
  const password = body.password;

  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  const db = getDb();
  const user = db.prepare(
    "SELECT id, username, display_name, password_hash FROM users WHERE username = $u COLLATE NOCASE"
  ).get({ $u: username }) as { id: string; username: string; display_name: string | null; password_hash: string } | null;

  if (!user || !verifyPassword(password, user.password_hash)) {
    return c.json({ error: "Invalid username or password" }, 401);
  }

  // Create a new session — doesn't invalidate other devices
  const token = generateToken();
  db.prepare("INSERT INTO sessions (token, user_id) VALUES ($token, $uid)")
    .run({ $token: token, $uid: user.id });
  db.prepare("UPDATE users SET last_seen_at = unixepoch() WHERE id = $id")
    .run({ $id: user.id });

  return c.json({
    ok: true,
    user: { id: user.id, username: user.username, displayName: user.display_name ?? user.username },
    token,
  });
});

// POST /api/auth/logout — invalidate current session token
router.post("/logout", (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) {
      const db = getDb();
      db.prepare("DELETE FROM sessions WHERE token = $t AND user_id = $uid")
        .run({ $t: token, $uid: userId });
    }
  }
  return c.json({ ok: true });
});

// GET /api/auth/me
router.get("/me", (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const db = getDb();
  const user = db.prepare(
    "SELECT id, username, display_name, created_at, last_seen_at FROM users WHERE id = $id"
  ).get({ $id: userId }) as { id: string; username: string; display_name: string | null; created_at: number; last_seen_at: number | null } | null;

  if (!user) return c.json({ error: "User not found" }, 404);

  const stats = db.prepare(`
    SELECT
      COUNT(*) as totalPlays,
      COUNT(DISTINCT track_id) as uniqueTracks
    FROM listening_history
    WHERE user_id = $uid AND action = 'play'
  `).get({ $uid: userId }) as { totalPlays: number; uniqueTracks: number };

  const playlistCount = (db.prepare(
    "SELECT COUNT(*) as n FROM playlists WHERE user_id = $uid"
  ).get({ $uid: userId }) as { n: number }).n;

  return c.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name ?? user.username,
    createdAt: user.created_at,
    lastSeenAt: user.last_seen_at,
    stats: { ...stats, playlists: playlistCount },
  });
});

// ─── Liked Tracks Sync ──────────────────────────────────────────────────────

// GET /api/auth/likes — get all liked track IDs for current user
router.get("/likes", (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const db = getDb();
  const rows = db.prepare("SELECT track_id FROM liked_tracks WHERE user_id = $uid ORDER BY liked_at DESC")
    .all({ $uid: userId }) as { track_id: string }[];

  return c.json({ trackIds: rows.map((r) => r.track_id) });
});

// POST /api/auth/likes/sync — sync liked tracks from client
// Body: { trackIds: string[] }
router.post("/likes/sync", async (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const body = await c.req.json<{ trackIds?: string[] }>();
  const trackIds = body.trackIds;
  if (!trackIds || !Array.isArray(trackIds)) return c.json({ error: "trackIds required" }, 400);

  const db = getDb();
  db.transaction(() => {
    // Get current server likes
    const serverLikes = new Set(
      (db.prepare("SELECT track_id FROM liked_tracks WHERE user_id = $uid").all({ $uid: userId }) as { track_id: string }[])
        .map((r) => r.track_id)
    );

    // Add new likes from client
    const insert = db.prepare("INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES ($uid, $tid)");
    for (const tid of trackIds) {
      if (!serverLikes.has(tid)) {
        insert.run({ $uid: userId, $tid: tid });
      }
    }
  })();

  // Return merged set
  const allLikes = db.prepare("SELECT track_id FROM liked_tracks WHERE user_id = $uid ORDER BY liked_at DESC")
    .all({ $uid: userId }) as { track_id: string }[];

  return c.json({ trackIds: allLikes.map((r) => r.track_id), count: allLikes.length });
});

// POST /api/auth/likes/toggle — like/unlike a track
// Accepts optional track metadata so liked tracks survive cache eviction
router.post("/likes/toggle", async (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const body = await c.req.json<{
    trackId?: string;
    track?: {
      source?: string;
      title?: string;
      artist?: string;
      album?: string;
      duration?: number;
      coverUrl?: string;
    };
  }>();
  if (!body.trackId) return c.json({ error: "trackId required" }, 400);

  const db = getDb();

  // If track metadata is provided, upsert it so liked tracks survive DB cache eviction
  if (body.track?.title && body.track?.artist && body.track?.source) {
    const source = body.track.source;
    if (source === "local" || source === "vk" || source === "soundcloud") {
      try {
        upsertTrack({
          id: body.trackId,
          source,
          title: body.track.title,
          artist: body.track.artist,
          album: body.track.album,
          duration: body.track.duration ?? 0,
          cover_url: body.track.coverUrl,
        });
      } catch { /* best effort — don't fail the like operation */ }
    }
  }

  const exists = db.prepare("SELECT 1 FROM liked_tracks WHERE user_id = $uid AND track_id = $tid")
    .get({ $uid: userId, $tid: body.trackId });

  if (exists) {
    db.prepare("DELETE FROM liked_tracks WHERE user_id = $uid AND track_id = $tid")
      .run({ $uid: userId, $tid: body.trackId });
    return c.json({ liked: false, trackId: body.trackId });
  } else {
    db.prepare("INSERT INTO liked_tracks (user_id, track_id) VALUES ($uid, $tid)")
      .run({ $uid: userId, $tid: body.trackId });
    return c.json({ liked: true, trackId: body.trackId });
  }
});

// GET /api/auth/liked-tracks — get liked tracks with full metadata
// Returns tracks joined with liked_tracks; includes basic info even if track is not in cache
router.get("/liked-tracks", (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const db = getDb();
  const rows = db.prepare(`
    SELECT t.*, lt.track_id as lt_track_id, lt.liked_at
    FROM liked_tracks lt
    LEFT JOIN tracks t ON t.id = lt.track_id
    WHERE lt.user_id = $uid
    ORDER BY lt.liked_at DESC
  `).all({ $uid: userId }) as Array<Record<string, unknown> & { id: string | null; lt_track_id: string; liked_at: number }>;

  // For likes where track metadata is missing (not yet cached), return a stub with just the ID
  const tracks = rows.map((row) => ({
    id: row.id ?? row.lt_track_id,
    source: row.source ?? "unknown",
    title: row.title ?? "Unknown Track",
    artist: row.artist ?? "Unknown Artist",
    album: row.album ?? null,
    duration: row.duration ?? 0,
    coverUrl: row.cover_url ?? null,
    likedAt: row.liked_at,
  }));

  return c.json({ tracks });
});

export default router;
