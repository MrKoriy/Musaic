import { Hono } from "hono";
import crypto from "crypto";
import { getYandexProvider } from "../providers/yandex.js";

const router = new Hono();

// Yandex OAuth device-flow credentials. Defaults are the public Yandex Music
// app client (widely used by unofficial tooling); override via env if needed.
const YANDEX_OAUTH_CLIENT_ID = process.env.YANDEX_OAUTH_CLIENT_ID?.trim() || "";
const YANDEX_OAUTH_CLIENT_SECRET = process.env.YANDEX_OAUTH_CLIENT_SECRET?.trim() || "";

// Device-flow auth state. The SERVER polls Yandex in the background (independent
// of the app's lifecycle) because the app must leave to a browser to authorize,
// which would suspend any client-side polling. The app just reads /device/status.
type DeviceAuthState = "idle" | "pending" | "done" | "expired" | "error";
let deviceAuth: { state: DeviceAuthState; login: string | null; plus: boolean; error: string | null } = {
  state: "idle", login: null, plus: false, error: null,
};
let devicePollTimer: ReturnType<typeof setInterval> | null = null;

function stopDevicePoll(): void {
  if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
}

async function exchangeDeviceToken(deviceCode: string): Promise<{ access_token?: string; error?: string }> {
  const res = await fetch("https://oauth.yandex.ru/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "device_code",
      code: deviceCode,
      client_id: YANDEX_OAUTH_CLIENT_ID,
      client_secret: YANDEX_OAUTH_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json()) as { access_token?: string; error?: string };
}

function beginDevicePolling(deviceCode: string, expiresAt: number, intervalMs: number): void {
  stopDevicePoll();
  devicePollTimer = setInterval(async () => {
    if (Date.now() > expiresAt) {
      deviceAuth = { state: "expired", login: null, plus: false, error: null };
      stopDevicePoll();
      return;
    }
    try {
      const tok = await exchangeDeviceToken(deviceCode);
      if (tok.error === "authorization_pending" || tok.error === "slow_down") return; // keep waiting
      if (!tok.access_token) {
        deviceAuth = { state: "error", login: null, plus: false, error: tok.error ?? "Authorization failed" };
        stopDevicePoll();
        return;
      }
      // Got a token — store it, then validate against Yandex via the sidecar.
      stopDevicePoll();
      const provider = getYandexProvider();
      provider.setToken(tok.access_token);
      try {
        const { login, plus } = await provider.validate();
        deviceAuth = { state: "done", login, plus, error: null };
        console.log(`[yandex] connected via device flow${login ? ` as ${login}` : ""} (plus=${plus})`);
      } catch (err) {
        provider.logout();
        deviceAuth = { state: "error", login: null, plus: false, error: err instanceof Error ? err.message : String(err) };
      }
    } catch {
      // Transient network error talking to Yandex — keep polling.
    }
  }, intervalMs);
  devicePollTimer.unref?.();
}

/**
 * POST /api/yandex/token
 * Body: { token: string }
 * Stores the account OAuth token (encrypted) and validates it against Yandex.
 */
router.post("/token", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
  if (!body.token?.trim()) return c.json({ error: "token required" }, 400);
  const provider = getYandexProvider();
  provider.setToken(body.token.trim());
  try {
    const { login, plus } = await provider.validate();
    if (!plus) {
      return c.json({
        ok: true,
        login,
        plus,
        warning: "Account has no active Yandex Plus — only 30s previews will be available.",
      });
    }
    return c.json({ ok: true, login, plus });
  } catch (err: unknown) {
    provider.logout();
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 401);
  }
});

/**
 * POST /api/yandex/device/start — begin OAuth device flow.
 * Returns a short user_code the user enters at verification_url (ya.ru/device).
 */
router.post("/device/start", async (c) => {
  try {
    const body = new URLSearchParams({
      client_id: YANDEX_OAUTH_CLIENT_ID,
      device_id: crypto.randomBytes(16).toString("hex"),
      device_name: "Musaic",
    });
    const res = await fetch("https://oauth.yandex.ru/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as {
      device_code?: string; user_code?: string; verification_url?: string;
      interval?: number; expires_in?: number; error?: string;
    };
    if (!res.ok || !data.device_code) {
      deviceAuth = { state: "error", login: null, plus: false, error: data.error ?? "device code error" };
      return c.json({ error: data.error ?? `Yandex device code error (HTTP ${res.status})` }, 502);
    }
    deviceAuth = { state: "pending", login: null, plus: false, error: null };
    const expiresAt = Date.now() + (data.expires_in ?? 300) * 1000;
    const intervalMs = Math.max(3, data.interval ?? 5) * 1000;
    beginDevicePolling(data.device_code, expiresAt, intervalMs);
    return c.json({
      userCode: data.user_code,
      verificationUrl: data.verification_url ?? "https://ya.ru/device",
      interval: data.interval ?? 5,
      expiresIn: data.expires_in ?? 300,
    });
  } catch (err: unknown) {
    deviceAuth = { state: "error", login: null, plus: false, error: err instanceof Error ? err.message : String(err) };
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/yandex/device/status — poll this from the app. The server captures
 * the token in the background, so this survives the app backgrounding while the
 * user authorizes in a browser.
 */
router.get("/device/status", (c) => {
  return c.json({
    authenticated: getYandexProvider().isAuthenticated(),
    state: deviceAuth.state,
    login: deviceAuth.login,
    plus: deviceAuth.plus,
    error: deviceAuth.error,
  });
});

/** GET /api/yandex/status */
router.get("/status", (c) => {
  const p = getYandexProvider();
  return c.json({ authenticated: p.isAuthenticated(), username: p.getUsername() });
});

/** GET /api/yandex/me — validate live and report login/plus */
router.get("/me", async (c) => {
  const p = getYandexProvider();
  if (!p.isAuthenticated()) return c.json({ authenticated: false, username: null });
  try {
    const { login, plus } = await p.validate();
    return c.json({ authenticated: true, username: login ?? p.getUsername(), plus });
  } catch (err) {
    return c.json({ authenticated: false, username: null, error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /api/yandex/logout */
router.post("/logout", (c) => {
  getYandexProvider().logout();
  return c.json({ ok: true });
});

/** GET /api/yandex/search?q=&count=&offset= */
router.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q?.trim()) return c.json({ error: "q required" }, 400);
  const count = Math.min(Number(c.req.query("count") ?? 30), 100);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  try {
    const tracks = await getYandexProvider().search(q, count, offset);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** GET /api/yandex/stream/:trackId */
router.get("/stream/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  try {
    const url = await getYandexProvider().getStreamUrl(trackId);
    return c.json({ url });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** GET /api/yandex/track/:trackId */
router.get("/track/:trackId", async (c) => {
  try {
    const meta = await getYandexProvider().getTrackMetadata(c.req.param("trackId"));
    return c.json(meta);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** GET /api/yandex/artist/:artistName */
router.get("/artist/:artistName", async (c) => {
  const artistName = decodeURIComponent(c.req.param("artistName"));
  try {
    const tracks = await getYandexProvider().getArtistTracks(artistName);
    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default router;
