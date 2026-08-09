import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { app } from "../index.js";
import { getDb } from "../db/index.js";
import { seedTrack, setupTestDb, teardownTestDb } from "./setup.js";

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return await app.request(new Request(`http://test.local${path}`, init));
}

async function register(): Promise<string> {
  const response = await request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: `user_${Math.random().toString(36).slice(2, 9)}`, password: "password-123" }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { token: string };
  return body.token;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("application authentication", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  test("requires authentication for mutations while leaving reads open", async () => {
    const anonymousHistory = await request("/api/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackId: "missing", action: "play" }),
    });
    expect(anonymousHistory.status).toBe(401);

    const anonymousScan = await request("/api/local/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(anonymousScan.status).toBe(401);

    seedTrack({ id: "public-track" });
    const publicRead = await request("/api/tracks");
    expect(publicRead.status).toBe(200);
  });

  test("rejects legacy tokens and expired sessions", async () => {
    const token = await register();
    const db = getDb();

    db.prepare("UPDATE users SET token = 'legacy-token' WHERE id = (SELECT user_id FROM sessions WHERE token = $token)")
      .run({ $token: token });
    const legacy = await request("/api/auth/me", { headers: bearer("legacy-token") });
    expect(legacy.status).toBe(401);

    db.prepare("UPDATE sessions SET expires_at = unixepoch() - 1 WHERE token = $token").run({ $token: token });
    const expired = await request("/api/auth/me", { headers: bearer(token) });
    expect(expired.status).toBe(401);
  });

  test("renews a valid session when it is used", async () => {
    const token = await register();
    const db = getDb();
    db.prepare("UPDATE sessions SET expires_at = unixepoch() + 60 WHERE token = $token").run({ $token: token });

    const response = await request("/api/auth/me", { headers: bearer(token) });
    expect(response.status).toBe(200);
    const renewed = db.prepare("SELECT expires_at FROM sessions WHERE token = $token").get({ $token: token }) as { expires_at: number };
    expect(renewed.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 60);
  });

  test("validates history against the track catalogue", async () => {
    const token = await register();
    const missing = await request("/api/history", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ trackId: "missing", action: "play" }),
    });
    expect(missing.status).toBe(404);

    const trackId = seedTrack({ id: "history-track" });
    const invalidRatio = await request("/api/history", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ trackId, action: "play", playedRatio: 1.1 }),
    });
    expect(invalidRatio.status).toBe(400);

    const accepted = await request("/api/history", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ trackId, action: "play", playedRatio: 0.5 }),
    });
    expect(accepted.status).toBe(200);
  });

  test("registers, logs in, reports the current user, and invalidates logout", async () => {
    const username = "auth_flow_user";
    const invalidRegistration = await request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "short_password_user", password: "short" }),
    });
    expect(invalidRegistration.status).toBe(400);
    expect(await invalidRegistration.json()).toEqual({ error: "Password must be at least 8 characters" });

    const registration = await request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "password-123", displayName: "Auth Flow" }),
    });
    expect(registration.status).toBe(200);
    const registeredBody = await registration.json() as {
      ok: boolean;
      token: string;
      user: { id: string; username: string; displayName: string };
    };
    expect(registeredBody).toEqual(expect.objectContaining({ ok: true, token: expect.any(String) }));
    expect(registeredBody.user).toEqual({
      id: expect.any(String),
      username,
      displayName: "Auth Flow",
    });
    expect(getDb().prepare("SELECT password_hash FROM users WHERE id = $id").get({ $id: registeredBody.user.id }))
      .toEqual(expect.objectContaining({ password_hash: expect.stringContaining(":") }));

    const duplicate = await request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: username.toUpperCase(), password: "password-123" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "Username already taken" });

    const wrongLogin = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "wrong-password" }),
    });
    expect(wrongLogin.status).toBe(401);
    expect(await wrongLogin.json()).toEqual({ error: "Invalid username or password" });

    const login = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: username.toUpperCase(), password: "password-123" }),
    });
    expect(login.status).toBe(200);
    const loginBody = await login.json() as { token: string; user: { id: string; username: string; displayName: string } };
    expect(loginBody.token).not.toBe(registeredBody.token);
    expect(loginBody.user).toEqual({ id: registeredBody.user.id, username, displayName: "Auth Flow" });

    const me = await request("/api/auth/me", { headers: bearer(loginBody.token) });
    expect(me.status).toBe(200);
    const meBody = await me.json() as {
      id: string;
      username: string;
      displayName: string;
      stats: { totalPlays: number; uniqueTracks: number; playlists: number };
    };
    expect(meBody).toEqual(expect.objectContaining({
      id: registeredBody.user.id,
      username,
      displayName: "Auth Flow",
      stats: { totalPlays: 0, uniqueTracks: 0, playlists: 0 },
    }));

    const logout = await request("/api/auth/logout", {
      method: "POST",
      headers: bearer(loginBody.token),
    });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });
    expect(getDb().prepare("SELECT 1 FROM sessions WHERE token = $token").get({ $token: loginBody.token })).toBeNull();

    const afterLogout = await request("/api/auth/me", { headers: bearer(loginBody.token) });
    expect(afterLogout.status).toBe(401);
    expect(await afterLogout.json()).toEqual({ error: "Not authenticated" });
  });

  test("does not expose filesystem paths in track responses", async () => {
    const trackId = seedTrack({ id: "private-path-track" });
    getDb().prepare("UPDATE tracks SET local_path = '/srv/music/private/song.flac' WHERE id = $id").run({ $id: trackId });

    const response = await request("/api/tracks");
    expect(response.status).toBe(200);
    const body = await response.json() as { tracks: Array<Record<string, unknown>> };
    expect(body.tracks[0]).not.toHaveProperty("local_path");
    expect(JSON.stringify(body)).not.toContain("/srv/music/private");
  });

  test("blocks artwork private addresses without auth and still serves authenticated-only routes", async () => {
    const artwork = await request("/api/artwork?url=http%3A%2F%2F169.254.169.254%2F");
    expect(artwork.status).toBe(400);
    expect(await artwork.json()).toEqual({ error: "Blocked address" });

    const anonymous = await request("/api/downloads/stream/local-track");
    expect(anonymous.status).toBe(401);

    const token = await register();
    const sensitive = await request("/api/stream/liliy-track", { headers: bearer(token) });
    expect(sensitive.status).toBe(404);
  });
});
