/**
 * Auth Routes — user registration, login, profile
 *
 * POST /api/auth/register  — create account
 * POST /api/auth/login     — get token
 * GET  /api/auth/me        — current user info
 */

import { Hono } from "hono";
import crypto from "crypto";
import { getDb } from "../db/index.js";

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
  if (!password || password.length < 4) {
    return c.json({ error: "Password must be at least 4 characters" }, 400);
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
    INSERT INTO users (id, username, display_name, password_hash, token)
    VALUES ($id, $username, $display_name, $hash, $token)
  `).run({ $id: id, $username: username, $display_name: displayName ?? username, $hash: hash, $token: token });

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

  const token = generateToken();
  db.prepare("UPDATE users SET token = $token, last_seen_at = unixepoch() WHERE id = $id")
    .run({ $token: token, $id: user.id });

  return c.json({
    ok: true,
    user: { id: user.id, username: user.username, displayName: user.display_name ?? user.username },
    token,
  });
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

export default router;
