import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
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
import { getDb, logListening, dropTracksSourceCheck } from "./db/index.js";
import { runMigrations } from "./db/migrations.js";
import { clearUserRecommendationCaches } from "./providers/taste-engine.js";
import { getLocalProvider } from "./providers/local.js";
import { getSoundCloudProvider } from "./providers/soundcloud.js";
import { log } from "./logger.js";

const SERVER_START = Date.now();
const SERVER_VERSION = "0.1.0";
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3001);

// ─── In-memory rate limiter ──────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 300);

const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Stricter rate limiter for auth endpoints (10 req/min per IP)
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_RATE_LIMIT_MAX = 10;
const authRateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkAuthRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = authRateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > AUTH_RATE_LIMIT_WINDOW_MS) {
    authRateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= AUTH_RATE_LIMIT_MAX;
}

// Periodically clean up expired entries; cap at 10k IPs
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(ip);
  }
  if (rateLimitMap.size > 10_000) rateLimitMap.clear();
  for (const [ip, entry] of authRateLimitMap) {
    if (now - entry.windowStart > AUTH_RATE_LIMIT_WINDOW_MS) authRateLimitMap.delete(ip);
  }
}, 60_000).unref();

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new Hono();

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
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "local";
  if (!checkRateLimit(ip)) {
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

// ─── Auth middleware — extract user from Bearer token (optional for most routes) ──
app.use("/api/*", async (c, next) => {
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) {
      try {
        const db = getDb();
        // Check sessions table first (multi-device), fallback to legacy users.token
        let user = db.prepare(`
          SELECT u.id, u.username FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.token = $t
        `).get({ $t: token }) as { id: string; username: string } | null;
        if (!user) {
          user = db.prepare("SELECT id, username FROM users WHERE token = $t").get({ $t: token }) as { id: string; username: string } | null;
        }
        if (user) {
          (c as any).set("userId", user.id);
          (c as any).set("username", user.username);
          db.prepare("UPDATE sessions SET last_used_at = unixepoch() WHERE token = $t").run({ $t: token });
        }
      } catch (err) {
        log.warn("auth", `Token validation error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return next();
});

// ─── Auth rate limiting (stricter than global) ──────────────────────────────
app.use("/api/auth/*", async (c, next) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "local";
  if (!checkAuthRateLimit(ip)) {
    return c.json({ error: "Too many auth attempts. Try again later." }, 429);
  }
  return next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

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
    musicDir: process.env.MUSIC_DIR ?? null,
    dbPath: process.env.DB_PATH ?? "musaic.db",
    port: PORT,
    platform: `${os.platform()}/${os.arch()}`,
    nodeVersion: process.version,
  });
});

app.on(["GET", "HEAD"], "/api/artwork", async (c) => {
  const rawUrl = c.req.query("url")?.trim();
  if (!rawUrl) {
    return c.json({ error: "url required" }, 400);
  }

  let upstreamURL: URL;
  try {
    upstreamURL = new URL(rawUrl);
  } catch {
    return c.json({ error: "Invalid artwork URL" }, 400);
  }

  if (!["http:", "https:"].includes(upstreamURL.protocol)) {
    return c.json({ error: "Unsupported artwork protocol" }, 400);
  }

  try {
    const upstream = await fetch(upstreamURL, {
      method: c.req.method,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok || (c.req.method != "HEAD" && !upstream.body)) {
      return c.json({ error: `Artwork fetch failed: ${upstream.status}` }, 502);
    }

    const headers = new Headers();
    headers.set("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
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

    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
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

  return c.json({ tracks: rows });
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
  const soundCloudIDs = uniqueIDs.filter((id) => id.startsWith("sc_"));

  if (soundCloudIDs.length > 0) {
    const provider = getSoundCloudProvider();
    // Fetch metadata concurrently in batches of 5 (instead of sequential N+1)
    const BATCH_SIZE = 5;
    for (let i = 0; i < soundCloudIDs.length; i += BATCH_SIZE) {
      const batch = soundCloudIDs.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((trackId) => provider.getTrackMetadata(trackId).then((meta) => ({ trackId, meta })))
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          const { trackId, meta } = result.value;
          try {
            db.prepare(`
              UPDATE tracks
              SET title = $title,
                  artist = $artist,
                  album = $album,
                  duration = $duration,
                  cover_url = COALESCE($cover_url, cover_url),
                  updated_at = unixepoch()
              WHERE id = $id
            `).run({
              $id: trackId,
              $title: meta.title,
              $artist: meta.artist,
              $album: meta.album ?? null,
              $duration: meta.duration,
              $cover_url: meta.coverUrl ?? null,
            });
          } catch { /* best effort */ }
        }
      }
    }
  }

  const placeholders = uniqueIDs.map((_, index) => `$id${index}`).join(", ");
  const params = Object.fromEntries(uniqueIDs.map((id, index) => [`$id${index}`, id]));
  const rows = db.prepare(`SELECT * FROM tracks WHERE id IN (${placeholders})`).all(params) as Array<Record<string, unknown> & { id: string }>;
  const rowsByID = new Map(rows.map((row) => [row.id, row]));
  const orderedRows = uniqueIDs
    .map((id) => rowsByID.get(id))
    .filter((row): row is Record<string, unknown> & { id: string } => Boolean(row));

  return c.json({
    tracks: orderedRows,
  });
});

// ─── History logging ──────────────────────────────────────────────────────────

app.post("/api/history", async (c) => {
  const body = await c.req.json<{
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
  }>();
  if (!body.trackId || !body.action) {
    return c.json({ error: "trackId and action required" }, 400);
  }
  const validActions = new Set(["play", "pause", "skip", "like", "unlike", "dislike", "complete"]);
  if (!validActions.has(body.action)) {
    return c.json({ error: "Invalid action" }, 400);
  }
  const userId = (c as any).get("userId") as string | undefined;
  const inserted = logListening(body.trackId, body.action, userId, body);
  clearUserRecommendationCaches(userId);
  return c.json({ ok: true, inserted });
});

// ─── Audio file serving ────────────────────────────────────────────────────────

app.get("/audio/local/:trackId", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  // Validate trackId to prevent path traversal
  if (/[\/\\]|\.\./.test(trackId)) {
    return c.json({ error: "Invalid track ID" }, 400);
  }
  const filePath = getLocalProvider().getFilePath(trackId);
  if (!filePath || !fs.existsSync(filePath)) {
    return c.json({ error: "File not found" }, 404);
  }
  // Resolve symlinks and verify path doesn't escape expected directories
  const realPath = fs.realpathSync(filePath);
  const allowedRoots = [
    process.env.MUSIC_DIR,
    process.env.DOWNLOADS_DIR ?? "./downloads",
  ].filter(Boolean).map((d) => fs.realpathSync(d!));
  if (realPath !== filePath && !allowedRoots.some((root) => realPath.startsWith(root))) {
    return c.json({ error: "Access denied" }, 403);
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

let httpServer: Server | null = null;

const serverInstance = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  log.info("server", `Server ready at http://${HOST}:${info.port}`);
  httpServer = serverInstance as unknown as Server;

  // Auto-scan music folder on startup
  const MUSIC_DIR = process.env.MUSIC_DIR;
  if (MUSIC_DIR && fs.existsSync(MUSIC_DIR)) {
    log.info("server", `Auto-scanning music dir: ${MUSIC_DIR}`);
    fetch(`http://127.0.0.1:${info.port}/api/local/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: MUSIC_DIR }),
    }).catch((err: unknown) => {
      log.warn("server", "Auto-scan request failed:", err instanceof Error ? err.message : String(err));
    });
  }
});

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
