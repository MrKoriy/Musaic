import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import os from "os";
import fs from "fs";
import path from "path";
import { createReadStream } from "fs";
import vkRoutes from "./routes/vk.js";
import scRoutes from "./routes/soundcloud.js";
import searchRoutes from "./routes/search.js";
import { localRouter, coversRouter, albumsRouter, artistsRouter, playlistsRouter, downloadsRouter } from "./routes/local.js";
import { recommendationsRouter } from "./routes/recommendations.js";
import lyricsRoutes from "./routes/lyrics.js";
import statsRoutes from "./routes/stats.js";
import smartPlaylistRoutes from "./routes/playlists-smart.js";
import { getDb } from "./db/index.js";
import { runMigrations } from "./db/migrations.js";
import { getLocalProvider } from "./providers/local.js";
import { log } from "./logger.js";

const SERVER_START = Date.now();
const SERVER_VERSION = "0.1.0";
const PORT = Number(process.env.PORT ?? 3001);

// ─── In-memory rate limiter ──────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 300;          // max requests per window per IP

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

// Periodically clean up expired entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(ip);
  }
}, 5 * 60_000).unref();

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new Hono();

// Request logging
app.use("*", honoLogger((msg) => log.info("http", msg)));

// CORS — allow configured origins or fall back to permissive (local dev / mobile app)
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((s: string) => s.trim());
app.use("*", cors({
  origin: allowedOrigins ?? "*",
}));

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

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route("/api/vk", vkRoutes);
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

app.get("/health", (c) => {
  const mem = process.memoryUsage();

  let dbOk = false;
  let trackCount = 0;
  try {
    const db = getDb();
    trackCount = (db.prepare("SELECT COUNT(*) as n FROM tracks").get() as { n: number }).n;
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

// ─── History logging ──────────────────────────────────────────────────────────

app.post("/api/history", async (c) => {
  const body = await c.req.json<{ trackId: string; action: string }>();
  if (!body.trackId || !body.action) {
    return c.json({ error: "trackId and action required" }, 400);
  }
  const db = getDb();
  db.prepare("INSERT INTO listening_history (track_id, action) VALUES ($id, $a)").run({
    $id: body.trackId,
    $a: body.action,
  });
  return c.json({ ok: true });
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
  if (realPath !== filePath && !realPath.startsWith("/")) {
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

log.info("server", `Starting Musaic v${SERVER_VERSION} on port ${PORT}`);
log.info("server", `DB: ${process.env.DB_PATH ?? "musaic.db"} | Downloads: ${process.env.DOWNLOADS_DIR ?? "downloads/"}`);

// Run DB migrations
try {
  const db = getDb();
  runMigrations(db);
} catch (err: unknown) {
  log.error("server", "Migration failed — aborting startup:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}

let httpServer: Server | null = null;

const serverInstance = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: PORT }, (info) => {
  log.info("server", `Server ready at http://0.0.0.0:${info.port}`);
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
