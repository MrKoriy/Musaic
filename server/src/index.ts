import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import vkRoutes from "./routes/vk.js";
import scRoutes from "./routes/soundcloud.js";
import searchRoutes from "./routes/search.js";
import { localRouter, coversRouter, albumsRouter, artistsRouter, playlistsRouter } from "./routes/local.js";
import { recommendationsRouter } from "./routes/recommendations.js";
import lyricsRoutes from "./routes/lyrics.js";
import { getDb } from "./db/index.js";
import { getLocalProvider } from "./providers/local.js";
import fs from "fs";
import path from "path";
import { createReadStream } from "fs";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors({ origin: "*" }));

// Health check
app.get("/health", (c) =>
  c.json({ ok: true, time: new Date().toISOString() })
);

// Routes
app.route("/api/vk", vkRoutes);
app.route("/api/sc", scRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/local", localRouter);
app.route("/api/covers", coversRouter);
app.route("/api/albums", albumsRouter);
app.route("/api/artists", artistsRouter);
app.route("/api/playlists", playlistsRouter);
app.route("/api/recommendations", recommendationsRouter);
app.route("/api/lyrics", lyricsRoutes);

/**
 * Serve local audio files
 * GET /audio/local/:trackId
 */
app.get("/audio/local/:trackId", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const filePath = getLocalProvider().getFilePath(trackId);
  if (!filePath || !fs.existsSync(filePath)) {
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

/**
 * GET /api/tracks - list all cached tracks
 */
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

/**
 * POST /api/history - log listening event
 */
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

const PORT = Number(process.env.PORT ?? 3001);

console.log(`[Musaic] Starting server on port ${PORT}...`);
console.log(`[Musaic] DB: ${process.env.DB_PATH ?? "musaic.db"}`);
console.log(`[Musaic] Downloads: ${process.env.DOWNLOADS_DIR ?? "downloads/"}`);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[Musaic] Server running at http://localhost:${info.port}`);
});
