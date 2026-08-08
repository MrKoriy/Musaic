import { Hono } from "hono";
import { getVKProvider } from "../providers/vk.js";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { streamTrack, StreamProxyError } from "../utils/stream-proxy.js";

const router = new Hono();

const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR ?? path.join(process.cwd(), "downloads");

// CSRF state store for OAuth flow — state token → expiry timestamp
const csrfStateStore = new Map<string, number>();
const CSRF_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

setInterval(() => {
  const now = Date.now();
  for (const [state, expiry] of csrfStateStore) {
    if (now > expiry) csrfStateStore.delete(state);
  }
}, 60_000).unref();

function callbackBaseUrl(c: { req: { header(name: string): string | undefined; url?: string } }): string {
  const forwardedProto = c.req.header("x-forwarded-proto");
  const host = c.req.header("host") ?? "localhost:3001";
  const requestProtocol = c.req.url ? new URL(c.req.url).protocol.replace(":", "") : undefined;
  const protocol = forwardedProto ?? requestProtocol ?? "http";
  return `${protocol}://${host}`;
}

/**
 * POST /api/vk/auth
 * Body: { username: string, password: string }
 */
router.post("/auth", async (c) => {
  if (process.env.ALLOW_VK_PASSWORD_AUTH !== "1") {
    return c.json({ error: "Password auth is disabled. Use OAuth token login instead." }, 403);
  }
  const body = await c.req.json<{ username?: string; password?: string }>();
  if (!body.username || !body.password) {
    return c.json({ error: "username and password required" }, 400);
  }
  try {
    await getVKProvider().authenticate(body.username, body.password);
    return c.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // 2FA redirect case
    if (msg.includes("need_validation") || msg.includes("2FA")) {
      return c.json({ error: msg, requires2FA: true }, 403);
    }
    return c.json({ error: msg }, 401);
  }
});

/**
 * GET /api/vk/oauth-url — returns OAuth URL for browser-based login.
 *
 * client_id is configurable via VK_OAUTH_CLIENT_ID. VK gates audio methods
 * per app: e.g. Kate Mobile (2685278) currently returns "Unknown method passed"
 * for audio.search and others. Default `6121396` (VK Admin) historically keeps
 * broader audio access; if it stops working, swap via env without redeploying.
 *
 * Known IDs to try: 2685278 (Kate), 6121396 (VK Admin), 2274003 (VK iOS),
 * 5350052 (Boom).
 */
const configuredVKClientId = process.env.VK_OAUTH_CLIENT_ID?.trim();
const VK_OAUTH_CLIENT_ID = configuredVKClientId && configuredVKClientId !== "2685278"
  ? configuredVKClientId
  : "6121396";

router.get("/oauth-url", (c) => {
  const redirectUri = `${callbackBaseUrl(c)}/api/vk/oauth-callback`;
  const state = crypto.randomBytes(16).toString("hex");
  csrfStateStore.set(state, Date.now() + CSRF_STATE_TTL_MS);
  const url = `https://oauth.vk.ru/authorize?client_id=${VK_OAUTH_CLIENT_ID}&display=mobile&redirect_uri=${encodeURIComponent(redirectUri)}&scope=audio,offline&response_type=token&v=5.131&revoke=1&state=${state}`;
  return c.json({ url, redirectUri, clientId: VK_OAUTH_CLIENT_ID });
});

/**
 * GET /api/vk/_probe — checks which VK audio methods the current token can call.
 * Used to diagnose "search returns empty" without grepping server logs.
 */
router.get("/_probe", async (c) => {
  const { getVkConfig } = await import("../db/index.js");
  const token = getVkConfig().token;
  if (!token) return c.json({ error: "not authenticated" }, 401);

  const probeMethods: Array<{ method: string; params: Record<string, string> }> = [
    { method: "users.get", params: {} },
    { method: "audio.search", params: { q: "test", count: "1" } },
    { method: "audio.get", params: { count: "1" } },
    { method: "audio.getById", params: { audios: "1_1" } },
    { method: "audio.getRecommendations", params: { count: "1" } },
    { method: "audio.searchPlaylists", params: { q: "test", count: "1" } },
  ];

  const UA = "KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)";
  const out: Record<string, string> = {};
  for (const { method, params } of probeMethods) {
    try {
      const url = `https://api.vk.ru/method/${method}?${new URLSearchParams({ ...params, v: "5.131", access_token: token })}`;
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8_000) });
      const j = await r.json() as { error?: { error_msg?: string }; response?: unknown };
      out[method] = j.error ? `ERR: ${j.error.error_msg}` : "OK";
    } catch (e) {
      out[method] = `THROW: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return c.json({ clientId: VK_OAUTH_CLIENT_ID, methods: out });
});

/**
 * GET /api/vk/oauth-callback — HTML page that extracts token from URL fragment
 * VK implicit flow puts token in the hash: #access_token=...&user_id=...
 * This page reads it via JS and POSTs to /api/vk/auth-token
 */
router.get("/oauth-callback", (c) => {
  const baseUrl = callbackBaseUrl(c);
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, sans-serif; background: #0d0d14; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 32px; text-align: center; max-width: 360px; }
    h2 { margin: 0 0 8px; }
    p { color: rgba(255,255,255,0.6); margin: 0; }
    .spinner { width: 32px; height: 32px; border: 3px solid rgba(255,255,255,0.1); border-top-color: #e91e8c; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 16px auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .success { color: #4ade80; }
    .error { color: #e91e8c; }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="spinner" id="spinner"></div>
    <h2>Connecting VK...</h2>
    <p id="status">Authorizing your account</p>
  </div>
  <script>
    (async function() {
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const token = params.get('access_token');
      const userId = params.get('user_id');
      const state = params.get('state');
      const statusEl = document.getElementById('status');
      const spinner = document.getElementById('spinner');

      if (!token) {
        spinner.style.display = 'none';
        statusEl.className = 'error';
        statusEl.textContent = 'No token received. Please try again.';
        return;
      }

      try {
        const res = await fetch('${baseUrl}/api/vk/auth-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, username: userId ? 'VK User ' + userId : 'VK User', state }),
        });
        const data = await res.json();
        spinner.style.display = 'none';
        if (data.ok) {
          statusEl.className = 'success';
          statusEl.textContent = 'Connected! You can close this page and return to Musaic.';
          document.querySelector('h2').textContent = 'VK Connected';
        } else {
          statusEl.className = 'error';
          statusEl.textContent = data.error || 'Connection failed';
        }
      } catch (e) {
        spinner.style.display = 'none';
        statusEl.className = 'error';
        statusEl.textContent = 'Network error: ' + e.message;
      }
    })();
  </script>
</body>
</html>`;
  return c.html(html);
});

/**
 * POST /api/vk/auth-token — authenticate with a pre-obtained token
 * Body: { token: string, username?: string }
 */
router.post("/auth-token", async (c) => {
  const body = await c.req.json<{ token?: string; username?: string; state?: string }>();
  if (!body.token) return c.json({ error: "token required" }, 400);

  // Verify CSRF state if one is in the store (OAuth flow was initiated via /oauth-url)
  if (csrfStateStore.size > 0 || body.state) {
    const expiry = body.state ? csrfStateStore.get(body.state) : undefined;
    if (!expiry || Date.now() > expiry) {
      return c.json({ error: "Invalid or expired OAuth state" }, 403);
    }
    csrfStateStore.delete(body.state!); // consume once
  }

  try {
    const provider = getVKProvider();
    provider.setToken(body.token, body.username ?? "VK User");
    await provider.validateAudioAccess();
    return c.json({ ok: true });
  } catch (err: unknown) {
    getVKProvider().logout();
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 401);
  }
});

/**
 * GET /api/vk/status
 */
router.get("/status", (c) => {
  return c.json({ authenticated: getVKProvider().isAuthenticated() });
});

/**
 * GET /api/vk/search?q=artist+song&count=50
 */
router.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q?.trim()) return c.json({ error: "q required" }, 400);
  try {
    const tracks = await getVKProvider().search(q);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/stream/:trackId
 * Returns the stream URL for a VK track (re-fetched if expired)
 */
router.get("/stream/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  return c.json({ url: `/api/stream/vk/${encodeURIComponent(trackId)}` });
});

/**
 * GET /api/vk/track/:trackId
 * Returns track metadata
 */
router.get("/track/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    const meta = await getVKProvider().getTrackMetadata(trackId);
    return c.json(meta);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/artist/:artistName
 */
router.get("/artist/:artistName", async (c) => {
  const artistName = decodeURIComponent(c.req.param("artistName"));
  try {
    const tracks = await getVKProvider().getArtistTracks(artistName);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/library?offset=0&count=100
 */
router.get("/library", async (c) => {
  const offset = Number(c.req.query("offset") ?? 0);
  const count = Math.min(Number(c.req.query("count") ?? 100), 100);
  try {
    const tracks = await getVKProvider().getUserLibrary(offset, count);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/vk/download
 * Body: { trackId: string }
 */
router.post("/download", async (c) => {
  const body = await c.req.json<{ trackId?: string }>();
  if (!body.trackId) return c.json({ error: "trackId required" }, 400);
  try {
    await getVKProvider().downloadTrack(body.trackId, DOWNLOADS_DIR);
    return c.json({ ok: true, trackId: body.trackId });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/recommendations?count=50
 */
router.get("/recommendations", async (c) => {
  const count = Math.min(Number(c.req.query("count") ?? 50), 100);
  try {
    const tracks = await getVKProvider().getRecommendations(count);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /audio/vk/:trackId — proxy/redirect to VK stream URL
 * App uses this to avoid exposing the raw VK URL
 */
router.get("/proxy/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    return await streamTrack({ source: "vk", trackId, range: c.req.header("range") });
  } catch (err: unknown) {
    if (err instanceof StreamProxyError) return c.json({ error: err.message }, err.status);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/me — returns authenticated user info
 */
router.get("/me", async (c) => {
  const p = getVKProvider();
  if (!p.isAuthenticated()) return c.json({ authenticated: false, username: null });
  try {
    await p.validateAudioAccess();
    return c.json({ authenticated: true, username: p.getUsername() });
  } catch (err) {
    p.logout();
    return c.json({
      authenticated: false,
      username: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * POST /api/vk/logout
 */
router.post("/logout", (c) => {
  getVKProvider().logout();
  return c.json({ ok: true });
});

/**
 * GET /api/vk/playlists?offset=0&count=50
 */
router.get("/playlists", async (c) => {
  const offset = Number(c.req.query("offset") ?? 0);
  const count = Math.min(Number(c.req.query("count") ?? 50), 100);
  try {
    const playlists = await getVKProvider().getPlaylists(offset, count);
    return c.json({ playlists });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/vk/playlists/:id/tracks?ownerId=xxx
 */
router.get("/playlists/:id/tracks", async (c) => {
  const playlistId = Number(c.req.param("id"));
  const ownerId = c.req.query("ownerId") ? Number(c.req.query("ownerId")) : undefined;
  if (isNaN(playlistId)) return c.json({ error: "Invalid playlist id" }, 400);
  try {
    const tracks = await getVKProvider().getPlaylistTracks(playlistId, ownerId);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default router;
