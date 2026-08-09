import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import os from "os";
import fs from "fs";
import path from "path";
import { createReadStream } from "fs";
import vkRoutes from "./routes/vk.js";
import yandexRoutes from "./routes/yandex.js";
import youtubeRoutes from "./routes/youtube.js";
import scRoutes from "./routes/soundcloud.js";
import searchRoutes from "./routes/search.js";
import { localRouter, coversRouter, albumsRouter, artistsRouter, playlistsRouter, downloadsRouter } from "./routes/local.js";
import { recommendationsRouter } from "./routes/recommendations.js";
import lyricsRoutes from "./routes/lyrics.js";
import statsRoutes from "./routes/stats.js";
import smartPlaylistRoutes from "./routes/playlists-smart.js";
import authRoutes from "./routes/auth.js";
import importRoutes from "./routes/import.js";
import streamRoutes from "./routes/stream.js";
import { getDb, logListening, dropTracksSourceCheck } from "./db/index.js";
import { runMigrations } from "./db/migrations.js";
import { clearUserRecommendationCaches } from "./providers/taste-engine.js";
import { getLocalProvider } from "./providers/local.js";
import { log } from "./logger.js";
import { registerRecommendationJobs } from "./jobs/index.js";
import { startScheduler } from "./jobs/scheduler.js";
import { optionalAuth, requireAuth } from "./middleware/auth.js";
import { publicTracks } from "./utils/public-track.js";
import { InMemoryRateLimiter, requestIp } from "./utils/rate-limit.js";
import { resolveAllowedLocalFile } from "./utils/stream-proxy.js";

const SERVER_START = Date.now();
const SERVER_VERSION = "0.1.0";
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3001);

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 300);
const globalRateLimiter = new InMemoryRateLimiter();
const routeRateLimiter = new InMemoryRateLimiter();
const AUTH_RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 10);
const AUTH_RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS ?? 60_000);
const PROVIDER_RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_PROVIDER_MAX ?? 60);
const PROVIDER_RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_PROVIDER_WINDOW_MS ?? 60_000);
const VK_AUTH_RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_VK_AUTH_MAX ?? 5);
const CHAT_RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_CHAT_MAX ?? 10);
const CHAT_RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_CHAT_WINDOW_MS ?? 60_000);
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;

setInterval(() => {
  globalRateLimiter.cleanup();
  routeRateLimiter.cleanup();
}, 60_000).unref();

// ─── App ─────────────────────────────────────────────────────────────────────

export const app = new Hono();

// Request logging
app.use("*", honoLogger((msg) => log.info("http", msg)));

// CORS — allow configured origins or fall back to permissive (local dev / mobile app)
const configuredOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean)
);

function resolveAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  if (configuredOrigins.size > 0) {
    return configuredOrigins.has(origin) ? origin : null;
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null;
}

class ArtworkProxyError extends Error {
  constructor(public readonly status: 400 | 413 | 415 | 502, message: string) {
    super(message);
  }
}

function blockedIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && b >= 18 && b <= 19);
}

function blockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0]!;
  const v4Suffix = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const withoutV4 = v4Suffix
    ? `${normalized.slice(0, normalized.length - v4Suffix.length)}${v4Suffix.split(".").slice(0, 2).map((_, index, values) => {
        if (index !== 0) return "";
        const octets = v4Suffix.split(".").map(Number);
        return `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
      }).join("")}`
    : normalized;
  const sections = withoutV4.split("::");
  if (sections.length > 2) return true;
  const parseSections = (value: string): bigint[] => value ? value.split(":").map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) throw new Error("invalid IPv6");
    return BigInt(`0x${part}`);
  }) : [];
  try {
    const left = parseSections(sections[0]!);
    const right = sections.length === 2 ? parseSections(sections[1]!) : [];
    const zeros = sections.length === 2 ? 8 - left.length - right.length : 0;
    if (zeros < 0 || (sections.length === 1 && left.length !== 8)) return true;
    const groups = [...left, ...Array.from({ length: zeros }, () => 0n), ...right];
    if (groups.length !== 8) return true;
    const value = groups.reduce((sum, group) => (sum << 16n) | group, 0n);
    const prefix = (bits: number): bigint => value >> BigInt(128 - bits);
    const mapped = value >> 32n === 0xffffn;
    const mappedIPv4 = Number(value & 0xffffffffn);
    const mappedAddress = `${mappedIPv4 >>> 24}.${(mappedIPv4 >>> 16) & 255}.${(mappedIPv4 >>> 8) & 255}.${mappedIPv4 & 255}`;
    return value === 0n || value === 1n || mapped && blockedIPv4(mappedAddress) ||
      prefix(7) === 0b1111110n || // fc00::/7 ULA
      prefix(10) === 0b1111111010n || // fe80::/10 link-local
      prefix(8) === 0xffn || // multicast
      value >> 32n === 0n; // IPv4-compatible/reserved ::/96
  } catch {
    return true;
  }
}

async function isAllowedArtworkURL(url: URL): Promise<boolean> {
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) return false;

  try {
    if (isIP(hostname) === 4) return !blockedIPv4(hostname);
    if (isIP(hostname) === 6) return !blockedIPv6(hostname);
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((entry) => entry.family === 4
      ? !blockedIPv4(entry.address)
      : !blockedIPv6(entry.address));
  } catch {
    return false;
  }
}

async function readLimitedBody(body: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ArtworkProxyError(413, "Artwork response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const allowedOrigin = resolveAllowedOrigin(origin);

  if (c.req.method === "OPTIONS") {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };
    if (allowedOrigin) {
      headers["Access-Control-Allow-Origin"] = allowedOrigin;
      headers["Vary"] = "Origin";
    }
    return new Response(null, { status: 204, headers });
  }

  await next();

  if (allowedOrigin) {
    c.header("Access-Control-Allow-Origin", allowedOrigin);
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    c.header("Vary", "Origin");
  }
});

// Rate limiting (skip for audio streaming)
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/audio/")) return next();
  const ip = requestIp(c.req);
  if (!globalRateLimiter.allow(ip, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    return c.json({ error: "Too Many Requests" }, 429);
  }
  return next();
});

// Request body size limit (5MB)
app.use("*", async (c, next) => {
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > 5 * 1024 * 1024) {
    return c.json({ error: "Request body too large (max 5MB)" }, 413);
  }
  return next();
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use("/api/*", async (c, next) => {
  return optionalAuth(c, next);
});

// Route-specific limits run after optional auth so chat can use a user key.
app.use("/api/auth/*", async (c, next) => {
  const path = c.req.path;
  if (path.endsWith("/register") || path.endsWith("/login")) {
    const ip = requestIp(c.req);
    if (!routeRateLimiter.allow(`auth:${ip}`, AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_WINDOW_MS)) {
      return c.json({ error: "Too many auth attempts. Try again later." }, 429);
    }
  }
  return next();
});

app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  const ip = requestIp(c.req);
  if (path.startsWith("/api/vk/")) {
    const limit = path === "/api/vk/auth" ? VK_AUTH_RATE_LIMIT_MAX : PROVIDER_RATE_LIMIT_MAX;
    if (!routeRateLimiter.allow(`vk:${path === "/api/vk/auth" ? "auth" : "all"}:${ip}`, limit, PROVIDER_RATE_LIMIT_WINDOW_MS)) {
      return c.json({ error: "Too Many Requests" }, 429);
    }
  } else if (path.startsWith("/api/yandex/")) {
    if (!routeRateLimiter.allow(`yandex:${ip}`, PROVIDER_RATE_LIMIT_MAX, PROVIDER_RATE_LIMIT_WINDOW_MS)) {
      return c.json({ error: "Too Many Requests" }, 429);
    }
  } else if (path === "/api/recommendations/chat") {
    const userKey = ((c as any).get("userId") as string | undefined) ?? ip;
    if (!routeRateLimiter.allow(`chat:${userKey}`, CHAT_RATE_LIMIT_MAX, CHAT_RATE_LIMIT_WINDOW_MS)) {
      return c.json({ error: "Too Many Requests" }, 429);
    }
  }
  return next();
});

function requiresAuth(path: string, method: string): boolean {
  if (path === "/api/auth/register" || path === "/api/auth/login") return false;
  if (path.startsWith("/api/auth/")) return true;
  // Artwork stays public unless REQUIRE_AUTH_READS=1 — covers should load for
  // any client page without a login session.
  if (path.startsWith("/api/downloads/")) return true;
  if (path.startsWith("/api/stream/")) return true;
  if (path.startsWith("/api/yandex/proxy/") || path.startsWith("/api/yandex/stream/")) return true;
  if (path.startsWith("/api/vk/stream/") || path.startsWith("/api/vk/proxy/")) return true;
  if (path.startsWith("/api/sc/stream/") || path.startsWith("/api/sc/proxy/")) return true;
  if (path.startsWith("/api/youtube/stream/")) return true;
  if (path.startsWith("/api/local/scan")) return true;
  if (path === "/api/history" && method === "POST") return true;
  if (path.startsWith("/api/import/") && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) return true;
  if (path.startsWith("/api/playlists") && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) return true;
  if (path.startsWith("/api/smart-playlists")) return true;
  if (path.startsWith("/api/lyrics/") && ["POST", "PUT", "DELETE"].includes(method)) return true;
  if (path === "/api/recommendations/chat" || path === "/api/recommendations/scrobble") return true;
  if (path === "/api/vk/auth" || path === "/api/vk/auth-token" || path === "/api/vk/_probe" || path === "/api/vk/logout" || path === "/api/vk/import") return true;
  if (path.startsWith("/api/yandex/token") || path.startsWith("/api/yandex/device/") || path === "/api/yandex/logout" || path === "/api/yandex/likes/import") return true;
  if (path.startsWith("/audio/local/")) return true;
  if (process.env.REQUIRE_AUTH_READS === "1" && ["GET", "HEAD"].includes(method) && path.startsWith("/api/")) return true;
  return false;
}

function stripPrivateResponseFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateResponseFields);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.includes("token=")) return "[redacted]";
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (["local_path", "localPath", "cover_path", "file_path", "dbPath", "musicDir", "stream_url", "streamUrl"].includes(key)) continue;
    result[key] = stripPrivateResponseFields(child);
  }
  return result;
}

app.use("/api/*", async (c, next) => {
  if (!requiresAuth(c.req.path, c.req.method)) return next();
  return requireAuth(c, next);
});

app.use("/audio/local/*", requireAuth);

app.use("/api/*", async (c, next) => {
  await next();
  const response = c.res;
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  const text = await response.clone().text();
  if (!text) return response;
  try {
    const payload = stripPrivateResponseFields(JSON.parse(text));
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(payload), { status: response.status, headers });
  } catch {
    return new Response(text, response);
  }
});

// ─── Routes ──────────────────────────────────────────────────────────────────

/*
 * The auth middleware above deliberately runs before routes. OPTIONS requests
 * have already been answered by the CORS middleware, so browser preflight is
 * never forced to carry a bearer token.
 */
app.route("/api/auth", authRoutes);
app.route("/api/import", importRoutes);
app.route("/api/vk", vkRoutes);
app.route("/api/yandex", yandexRoutes);
app.route("/api/youtube", youtubeRoutes);
app.route("/api/sc", scRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/local", localRouter);
app.route("/api/covers", coversRouter);
app.route("/api/albums", albumsRouter);
app.route("/api/artists", artistsRouter);
app.route("/api/playlists", playlistsRouter);
app.route("/api/downloads", downloadsRouter);
app.route("/api/stream", streamRoutes);
app.route("/api/recommendations", recommendationsRouter);
app.route("/api/lyrics", lyricsRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/smart-playlists", smartPlaylistRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────

// Cached track count for health check (refreshed every 60s)
let cachedTrackCount = 0;
let trackCountLastRefresh = 0;
function getCachedTrackCount(): number {
  const now = Date.now();
  if (now - trackCountLastRefresh > 60_000) {
    try {
      cachedTrackCount = (getDb().prepare("SELECT COUNT(*) as n FROM tracks").get() as { n: number }).n;
    } catch { /* keep previous value */ }
    trackCountLastRefresh = now;
  }
  return cachedTrackCount;
}

app.get("/health", (c) => {
  const mem = process.memoryUsage();

  let dbOk = false;
  let trackCount = 0;
  try {
    const db = getDb();
    db.prepare("SELECT 1").get(); // lightweight connectivity check
    trackCount = getCachedTrackCount();
    dbOk = true;
  } catch { /* ignore */ }

  let diskInfo: { freeMB?: number; totalMB?: number } = {};
  try {
    const stat = (fs as any).statfsSync?.(process.env.DB_PATH ?? ".");
    if (stat) {
      diskInfo = {
        freeMB: Math.round((stat.bfree * stat.bsize) / 1024 / 1024),
        totalMB: Math.round((stat.blocks * stat.bsize) / 1024 / 1024),
      };
    }
  } catch { /* not available on all runtimes */ }

  return c.json({
    ok: dbOk,
    time: new Date().toISOString(),
    uptime: Math.floor((Date.now() - SERVER_START) / 1000),
    db: { ok: dbOk, trackCount },
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    ...diskInfo,
  });
});

// ─── Server info ──────────────────────────────────────────────────────────────

app.get("/api/server/info", (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const db = getDb();
  const trackCount = (db.prepare("SELECT COUNT(*) as n FROM tracks").get() as { n: number }).n;
  const lyricsCount = (db.prepare("SELECT COUNT(*) as n FROM lyrics_cache").get() as { n: number }).n;
  const historyCount = (db.prepare("SELECT COUNT(*) as n FROM listening_history").get() as { n: number }).n;

  return c.json({
    version: SERVER_VERSION,
    uptime: Math.floor((Date.now() - SERVER_START) / 1000),
    startedAt: new Date(SERVER_START).toISOString(),
    tracks: trackCount,
    lyricsCache: lyricsCount,
    listeningHistory: historyCount,
    port: PORT,
    platform: `${os.platform()}/${os.arch()}`,
    nodeVersion: process.version,
  });
});

/**
 * Unwrap nested artwork proxy chains (cover_url values that were accidentally
 * re-wrapped as /api/artwork?url=/api/artwork?url=... during import cycles).
 * Returns the outermost non-proxy target URL, or null if the input is invalid.
 */
function unwrapArtworkChain(raw: string): string | null {
  let current = raw.trim();
  if (current.startsWith("/")) return current;
  for (let depth = 0; depth < 10; depth++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return null;
    }
    if (!/^\/api\/artwork(?:\/|$)/.test(parsed.pathname)) return current;
    const inner = parsed.searchParams.get("url")?.trim();
    if (!inner) return null;
    current = inner;
  }
  return null;
}

app.on(["GET", "HEAD"], "/api/artwork", async (c) => {
  const rawUrl = c.req.query("url")?.trim();
  if (!rawUrl) {
    return c.json({ error: "url required" }, 400);
  }

  let upstreamURL: URL;
  try {
    const unwrapped = unwrapArtworkChain(rawUrl);
    if (!unwrapped) {
      return c.json({ error: "Invalid artwork URL" }, 400);
    }
    upstreamURL = new URL(unwrapped);
  } catch {
    return c.json({ error: "Invalid artwork URL" }, 400);
  }

  if (!["http:", "https:"].includes(upstreamURL.protocol)) {
    return c.json({ error: "Unsupported artwork protocol" }, 400);
  }

  try {
    let currentURL = upstreamURL;
    let upstream: Response | null = null;
    for (let redirect = 0; redirect <= 5; redirect++) {
      if (!(await isAllowedArtworkURL(currentURL))) {
        throw new ArtworkProxyError(400, "Blocked address");
      }
      upstream = await fetch(currentURL, {
        method: c.req.method,
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get("location");
      if (!location || redirect === 5) throw new ArtworkProxyError(502, "Too many artwork redirects");
      currentURL = new URL(location, currentURL);
    }

    if (!upstream) throw new ArtworkProxyError(502, "Artwork fetch failed");

    if (!upstream.ok || (c.req.method !== "HEAD" && !upstream.body)) {
      return c.json({ error: `Artwork fetch failed: ${upstream.status}` }, 502);
    }

    const contentType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!contentType?.startsWith("image/")) {
      return c.json({ error: "Artwork response is not an image" }, 415);
    }

    const contentLength = Number(upstream.headers.get("content-length") ?? 0);
    if (contentLength > MAX_ARTWORK_BYTES) {
      throw new ArtworkProxyError(413, "Artwork response too large");
    }

    const headers = new Headers();
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", upstream.headers.get("cache-control") ?? "public, max-age=86400");
    for (const header of ["content-length", "etag", "last-modified", "accept-ranges"]) {
      const value = upstream.headers.get(header);
      if (value) {
        headers.set(header, value);
      }
    }

    if (c.req.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    const body = await readLimitedBody(upstream.body as ReadableStream<Uint8Array>, MAX_ARTWORK_BYTES);
    headers.delete("content-length");
    headers.set("Content-Length", String(body.byteLength));
    return new Response(body, { status: 200, headers });
  } catch (err) {
    if (err instanceof ArtworkProxyError) return c.json({ error: err.message }, err.status);
    return c.json({ error: err instanceof Error ? err.message : "Artwork fetch failed" }, 500);
  }
});

// ─── Track listing ────────────────────────────────────────────────────────────

app.get("/api/tracks", (c) => {
  const db = getDb();
  const source = c.req.query("source");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const offset = Number(c.req.query("offset") ?? 0);

  const rows = source
    ? db.prepare("SELECT * FROM tracks WHERE source = $s LIMIT $l OFFSET $o").all({ $s: source, $l: limit, $o: offset })
    : db.prepare("SELECT * FROM tracks LIMIT $l OFFSET $o").all({ $l: limit, $o: offset });

  return c.json({ tracks: publicTracks(rows as Record<string, unknown>[]) });
});

app.get("/api/tracks/by-ids", async (c) => {
  const db = getDb();
  const ids = (c.req.query("ids") ?? "")
    .split(",")
    .map((value) => decodeURIComponent(value).trim())
    .filter(Boolean)
    .slice(0, 500);

  if (ids.length === 0) {
    return c.json({ tracks: [] });
  }

  const uniqueIDs = Array.from(new Set(ids));

  const placeholders = uniqueIDs.map((_, index) => `$id${index}`).join(", ");
  const params = Object.fromEntries(uniqueIDs.map((id, index) => [`$id${index}`, id]));
  const rows = db.prepare(`SELECT * FROM tracks WHERE id IN (${placeholders})`).all(params) as Array<Record<string, unknown> & { id: string }>;
  const rowsByID = new Map(rows.map((row) => [row.id, row]));
  const orderedRows = uniqueIDs
    .map((id) => rowsByID.get(id))
    .filter((row): row is Record<string, unknown> & { id: string } => Boolean(row));

  return c.json({ tracks: publicTracks(orderedRows) });
});

// ─── History logging ──────────────────────────────────────────────────────────

app.post("/api/history", async (c) => {
  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody, "utf8") > 8 * 1024) {
    return c.json({ error: "Request body too large (max 8KB)" }, 413);
  }

  let body: {
    trackId: string;
    action: string;
    eventId?: string;
    playedMs?: number;
    durationMs?: number;
    playedRatio?: number;
    sessionId?: string;
    requestId?: string;
    surface?: string;
    isOrganic?: boolean;
    position?: number;
    context?: Record<string, unknown>;
  };
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return c.json({ error: "JSON object body required" }, 400);
    }
    body = parsed as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.trackId !== "string" || !body.trackId.trim() || body.trackId.length > 256 ||
      typeof body.action !== "string" || !body.action.trim()) {
    return c.json({ error: "trackId and action required" }, 400);
  }
  const validActions = new Set(["play", "pause", "skip", "like", "unlike", "dislike", "complete"]);
  if (!validActions.has(body.action)) {
    return c.json({ error: "Invalid action" }, 400);
  }
  for (const value of [body.playedMs, body.durationMs, body.position]) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      return c.json({ error: "Playback values must be finite non-negative numbers" }, 400);
    }
  }
  if (body.playedRatio !== undefined &&
      (typeof body.playedRatio !== "number" || !Number.isFinite(body.playedRatio) || body.playedRatio < 0 || body.playedRatio > 1)) {
    return c.json({ error: "playedRatio must be between 0 and 1" }, 400);
  }
  if (body.playedMs !== undefined && body.durationMs !== undefined && body.durationMs > 0 && body.playedMs > body.durationMs) {
    return c.json({ error: "playedMs cannot exceed durationMs" }, 400);
  }
  if (body.context !== undefined && JSON.stringify(body.context).length > 4 * 1024) {
    return c.json({ error: "context too large" }, 400);
  }
  const db = getDb();
  const track = db.prepare("SELECT 1 FROM tracks WHERE id = $id").get({ $id: body.trackId.trim() });
  if (!track) return c.json({ error: "Track not found" }, 404);
  const userId = (c as any).get("userId") as string | undefined;
  const inserted = logListening(body.trackId.trim(), body.action, userId, body);
  // Pause is transport state, not a preference signal. It must not evict the
  // taste/profile caches (and Daily snapshots are never part of this helper).
  if (inserted && body.action !== "pause") clearUserRecommendationCaches(userId);
  return c.json({ ok: true, inserted });
});

// ─── Audio file serving ────────────────────────────────────────────────────────

app.get("/audio/local/:trackId", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  // Validate trackId to prevent path traversal
  if (/[\/\\]|\.\./.test(trackId)) {
    return c.json({ error: "Invalid track ID" }, 400);
  }
  const filePath = resolveAllowedLocalFile(getLocalProvider().getFilePath(trackId) ?? "");
  if (!filePath) {
    return c.json({ error: "File not found" }, 404);
  }

  const stat = fs.statSync(filePath);
  const rangeHeader = c.req.header("Range");
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
  };
  const contentType = mimeTypes[ext] ?? "audio/mpeg";

  if (rangeHeader) {
    const [startStr, endStr] = rangeHeader.replace("bytes=", "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    const stream = createReadStream(filePath, { start, end });
    return new Response(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunkSize),
        "Content-Type": contentType,
      },
    });
  }

  const stream = createReadStream(filePath);
  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
      "Content-Type": contentType,
    },
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

if (import.meta.main) {
log.info("server", `Starting Musaic v${SERVER_VERSION} on ${HOST}:${PORT}`);
log.info("server", `DB: ${process.env.DB_PATH ?? "musaic.db"} | Downloads: ${process.env.DOWNLOADS_DIR ?? "downloads/"}`);

// Run DB migrations
try {
  const db = getDb();
  runMigrations(db);
  // After column migrations: drop the legacy source CHECK so yandex/youtube cache.
  dropTracksSourceCheck(db);
} catch (err: unknown) {
  log.error("server", "Migration failed — aborting startup:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}

registerRecommendationJobs();
startScheduler();

let httpServer: Server | null = null;
let bunServer: { port?: number; stop(closeActiveConnections?: boolean): void } | null = null;

function startAutoScan(): void {
  const MUSIC_DIR = process.env.MUSIC_DIR;
  if (!MUSIC_DIR || !fs.existsSync(MUSIC_DIR)) return;
  log.info("server", `Auto-scanning music dir: ${MUSIC_DIR}`);
  Promise.resolve(localRouter.fetch(new Request("http://internal/api/local/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir: MUSIC_DIR }),
  }))).catch((err: unknown) => {
    log.warn("server", "Auto-scan request failed:", err instanceof Error ? err.message : String(err));
  });
}

const tlsCertPath = process.env.TLS_CERT?.trim();
const tlsKeyPath = process.env.TLS_KEY?.trim();
if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) {
  throw new Error("TLS_CERT and TLS_KEY must be configured together");
}

if (tlsCertPath && tlsKeyPath) {
  if (!fs.existsSync(tlsCertPath) || !fs.existsSync(tlsKeyPath)) {
    throw new Error("Configured TLS_CERT or TLS_KEY file does not exist");
  }
  const activeBunServer = Bun.serve({
    fetch: app.fetch,
    hostname: HOST,
    port: PORT,
    tls: {
      cert: Bun.file(tlsCertPath),
      key: Bun.file(tlsKeyPath),
    },
  });
  bunServer = activeBunServer;
  log.info("server", `Server ready at https://${HOST}:${activeBunServer.port}`);
  startAutoScan();
} else {
  const serverInstance = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
    log.info("server", `Server ready at http://${HOST}:${info.port}`);
    httpServer = serverInstance as unknown as Server;
    startAutoScan();
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  log.info("server", `Received ${signal} — shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    log.warn("server", "Graceful shutdown timeout — forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref?.();

  if (httpServer) {
    httpServer.close(() => {
      log.info("server", "HTTP server closed");
      try {
        (getDb() as any).close?.();
        log.info("server", "DB closed");
      } catch { /* ignore */ }
      log.info("server", "Shutdown complete");
      clearTimeout(forceExit);
      process.exit(0);
    });
  } else if (bunServer) {
    bunServer.stop(true);
    log.info("server", "HTTP server closed");
    try {
      (getDb() as any).close?.();
      log.info("server", "DB closed");
    } catch { /* ignore */ }
    clearTimeout(forceExit);
    process.exit(0);
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err: Error) => {
  log.error("server", "Uncaught exception:", err.message, err.stack ?? "");
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason: unknown) => {
  log.error("server", "Unhandled rejection:", String(reason));
});
}
