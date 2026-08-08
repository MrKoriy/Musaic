import type { Context, Next } from "hono";
import { getDb } from "../db/index.js";
import { runWithRequestUser } from "../utils/request-scope.js";

const DEFAULT_SESSION_TTL_DAYS = 90;

function sessionTtlSeconds(): number {
  const configured = Number(process.env.SESSION_TTL_DAYS ?? DEFAULT_SESSION_TTL_DAYS);
  const days = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SESSION_TTL_DAYS;
  return Math.floor(days * 24 * 60 * 60);
}

function bearerToken(c: Context): string | null {
  const value = c.req.header("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

export function authenticateRequest(c: Context): boolean {
  const token = bearerToken(c);
  if (!token) return false;

  try {
    const db = getDb();
    const user = db.prepare(`
      SELECT u.id, u.username
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = $token
        AND COALESCE(s.expires_at, s.created_at + $ttl) >= unixepoch()
    `).get({ $token: token, $ttl: sessionTtlSeconds() }) as {
      id: string;
      username: string;
    } | null;

    if (!user) {
      db.prepare("DELETE FROM sessions WHERE token = $token AND expires_at < unixepoch()")
        .run({ $token: token });
      return false;
    }

    const expiresAt = Math.floor(Date.now() / 1000) + sessionTtlSeconds();
    db.prepare(`
      UPDATE sessions
      SET last_used_at = unixepoch(), expires_at = $expiresAt
      WHERE token = $token
    `).run({ $token: token, $expiresAt: expiresAt });

    c.set("userId", user.id);
    c.set("username", user.username);
    c.set("authToken", token);
    return true;
  } catch {
    return false;
  }
}

export async function optionalAuth(c: Context, next: Next): Promise<Response | void> {
  authenticateRequest(c);
  return runWithRequestUser((c.get("userId") as string | undefined) ?? null, () => next());
}

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  if (!authenticateRequest(c)) {
    return c.json({ error: "Not authenticated" }, 401);
  }
  return next();
}

export function requestUserId(c: Context): string | null {
  return c.get("userId") as string | null;
}

export function requestAuthToken(c: Context): string | null {
  return c.get("authToken") as string | null;
}
