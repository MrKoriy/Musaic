import { Hono } from "hono";
import fs from "fs";
import path from "path";
import { createReadStream } from "fs";
import crypto from "crypto";
import { getDb } from "../../db/index.js";
import { getLocalProvider } from "../../providers/local.js";
import { FfmpegQueueFullError, runFfmpeg } from "../../utils/ffmpeg-queue.js";
import { resolveAllowedLocalFile } from "../../utils/stream-proxy.js";

const cacheLocks = new Map<string, Promise<void>>();

function safeCacheKey(trackId: string): string {
  return crypto.createHash("sha256").update(trackId).digest("hex");
}

async function withCacheLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = cacheLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  cacheLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (cacheLocks.get(key) === current) cacheLocks.delete(key);
  }
}

function safeTrackId(trackId: string): boolean {
  return Boolean(trackId) && !/[\\/]|\.\./.test(trackId) && trackId.length <= 256;
}

/** Map the app's stream-quality label to a target bitrate (kbps). */
function qualityToBitrate(quality: string | undefined): number {
  switch (quality) {
    case "low": return 128;
    case "normal": return 192;
    case "high":
    default: return 320;
  }
}

/**
 * Resolve the upstream audio URL for a non-local track by source. This is the
 * playback path for every streaming source - including VK, which stays here so
 * already-liked VK tracks keep playing even though VK is gone from discovery.
 *
 * `bitrate` is honored by Yandex (real quality tiers); other sources serve a
 * fixed quality determined by the source, so it's a no-op there.
 */
async function resolveUpstreamUrl(source: string, trackId: string, bitrate = 320): Promise<string> {
  switch (source) {
    case "vk": {
      const { getVKProvider } = await import("../../providers/vk.js");
      return getVKProvider().getStreamUrl(trackId);
    }
    case "yandex": {
      const { getYandexProvider } = await import("../../providers/yandex.js");
      return getYandexProvider().getStreamUrl(trackId, { bitrate });
    }
    case "youtube": {
      const { getYouTubeProvider } = await import("../../providers/youtube.js");
      return getYouTubeProvider().getStreamUrl(trackId);
    }
    case "soundcloud": {
      const { getSoundCloudProvider } = await import("../../providers/soundcloud.js");
      return getSoundCloudProvider().getStreamUrl(trackId);
    }
    default:
      throw new Error(`Unsupported stream source: ${source}`);
  }
}

async function fetchUpstreamAudio(source: string, trackId: string, bitrate = 320): Promise<Response> {
  if (source === "yandex") {
    const { getYandexProvider } = await import("../../providers/yandex.js");
    return getYandexProvider().stream(trackId, { bitrate, codec: "mp3" });
  }
  const upstreamUrl = await resolveUpstreamUrl(source, trackId, bitrate);
  return fetch(upstreamUrl, { signal: AbortSignal.timeout(60_000) });
}

function serveFileWithRange(filePath: string, rangeHeader: string | null): Response {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] ?? "audio/mpeg";

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1]!, 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = createReadStream(filePath, { start, end });
      return new Response(stream as unknown as ReadableStream, {
        status: 206,
        headers: new Headers({
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Content-Length": String(chunkSize),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
        }),
      });
    }
  }

  const stream = createReadStream(filePath);
  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: new Headers({
      "Content-Type": mime,
      "Content-Length": String(fileSize),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    }),
  });
}

const MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/opus",
  ".aiff": "audio/aiff", ".aif": "audio/aiff",
};

export const downloadsRouter = new Hono();

/**
 * GET /api/downloads/stream/:trackId
 * Pipe any track's audio bytes to the client for offline download.
 * - local: streams from disk
 * - vk/soundcloud: fetches from upstream URL and pipes
 */
downloadsRouter.get("/stream/:trackId", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  if (!safeTrackId(trackId)) return c.json({ error: "Invalid track ID" }, 400);
  const db = getDb();
  const track = db.prepare("SELECT * FROM tracks WHERE id = $id").get({ $id: trackId }) as {
    id: string; source: string; title: string; local_path?: string;
  } | null;

  if (!track) return c.json({ error: "Track not found" }, 404);

  if (track.source === "local") {
    const filePath = resolveAllowedLocalFile(getLocalProvider().getFilePath(trackId) ?? "");
    if (!filePath) {
      return c.json({ error: "Local file not found" }, 404);
    }
    return serveFileWithRange(filePath, c.req.header("range") ?? null);
  }

  // For streaming sources: download to local cache, then serve with Range support.
  // SoundCloud CDN does NOT support HTTP Range requests (signed CloudFront URLs),
  // so AVPlayer cannot seek in a proxied stream. We must cache locally first.
  // Cache is keyed by quality so changing Stream Quality genuinely re-fetches
  // (matters for Yandex, which has real bitrate tiers).
  const quality = c.req.query("quality") ?? "high";
  const bitrate = qualityToBitrate(quality);
  const CACHE_DIR = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads");
  const cacheSuffix = track.source === "yandex" ? `__${quality}` : "";
  const cachedPath = path.join(CACHE_DIR, `${safeCacheKey(trackId)}${cacheSuffix}.mp3`);

  try {
    // Download if not cached
    await withCacheLock(cachedPath, async () => {
      if (fs.existsSync(cachedPath)) return;
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const upstream = await fetchUpstreamAudio(track.source, trackId, bitrate);
      if (!upstream.ok || !upstream.body) throw new Error(`Download failed: ${upstream.status}`);
      const tmpPath = `${cachedPath}.${process.pid}.${Date.now()}.tmp`;
      const writer = fs.createWriteStream(tmpPath, { flags: "wx" });
      const { Readable } = await import("stream");
      try {
        await new Promise<void>((resolve, reject) => {
          Readable.fromWeb(upstream.body as any).pipe(writer);
          writer.on("finish", resolve);
          writer.on("error", reject);
        });
        fs.renameSync(tmpPath, cachedPath);
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* already renamed */ }
      }
    });

    // Serve from cache - use Bun.file() which has native Range support
    return serveFileWithRange(cachedPath, c.req.header("range") ?? null);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Stream error" }, 500);
  }
});

/**
 * GET /api/downloads/compressed/:trackId
 * Download a track transcoded to AAC 128kbps M4A (~3-5MB per song vs 30-50MB FLAC).
 * Query params: bitrate (default 128, max 256)
 */
downloadsRouter.get("/compressed/:trackId", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  if (!safeTrackId(trackId)) return c.json({ error: "Invalid track ID" }, 400);
  const bitrate = Math.min(256, Math.max(64, Number(c.req.query("bitrate") ?? 128)));
  const db = getDb();
  const track = db.prepare("SELECT * FROM tracks WHERE id = $id").get({ $id: trackId }) as {
    id: string; source: string; title: string; artist: string; duration: number; local_path?: string;
  } | null;

  if (!track) return c.json({ error: "Track not found" }, 404);

  const CACHE_DIR = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads");
  const compressedDir = path.join(CACHE_DIR, "compressed");
  const cacheKey = safeCacheKey(trackId);
  const compressedPath = path.join(compressedDir, `${cacheKey}_${bitrate}.m4a`);

  if (fs.existsSync(compressedPath)) {
    return serveFileWithRange(compressedPath, c.req.header("range") ?? null);
  }

  let sourcePath: string;

  if (track.source === "local") {
    const filePath = resolveAllowedLocalFile(getLocalProvider().getFilePath(trackId) ?? "");
    if (!filePath) {
      return c.json({ error: "Local file not found" }, 404);
    }
    if (filePath.endsWith(".mp3")) {
      const stat = fs.statSync(filePath);
      if (stat.size < 8 * 1024 * 1024) {
        return serveFileWithRange(filePath, c.req.header("range") ?? null);
      }
    }
    sourcePath = filePath;
  } else {
    const rawCachedPath = path.join(CACHE_DIR, `${cacheKey}.mp3`);
    try {
      await withCacheLock(rawCachedPath, async () => {
        if (fs.existsSync(rawCachedPath)) return;
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const upstream = await fetchUpstreamAudio(track.source, trackId);
        if (!upstream.ok || !upstream.body) throw new Error(`Download failed: ${upstream.status}`);
        const tmpPath = `${rawCachedPath}.${process.pid}.${Date.now()}.tmp`;
        const writer = fs.createWriteStream(tmpPath, { flags: "wx" });
        const { Readable } = await import("stream");
        try {
          await new Promise<void>((resolve, reject) => {
            Readable.fromWeb(upstream.body as any).pipe(writer);
            writer.on("finish", resolve);
            writer.on("error", reject);
          });
          fs.renameSync(tmpPath, rawCachedPath);
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* already renamed */ }
        }
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Download error" }, 500);
    }
    sourcePath = rawCachedPath;
  }

  try {
    if (!fs.existsSync(sourcePath)) {
      return c.json({ error: `Source file not found: ${sourcePath}` }, 404);
    }
    fs.mkdirSync(compressedDir, { recursive: true });
    await withCacheLock(compressedPath, async () => {
      if (fs.existsSync(compressedPath)) return;
      const tmpOut = `${compressedPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await runFfmpeg([
          "-nostdin", "-i", sourcePath,
          "-f", "mp4",
          "-c:a", "aac", "-b:a", `${bitrate}k`,
          "-movflags", "+faststart", "-vn", "-y", tmpOut,
        ], { timeoutMs: 5 * 60_000 });
        if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 100) throw new Error("Transcoding produced empty file");
        fs.renameSync(tmpOut, compressedPath);
      } finally {
        try { fs.unlinkSync(tmpOut); } catch { /* already renamed */ }
      }
    });
  } catch (err) {
    try { fs.unlinkSync(compressedPath + ".tmp"); } catch {}
    if (err instanceof FfmpegQueueFullError) {
      return c.json({ error: "Transcoding queue is full. Try again later." }, 429);
    }
    return c.json({ error: err instanceof Error ? err.message : "Transcoding failed" }, 500);
  }

  return serveFileWithRange(compressedPath, c.req.header("range") ?? null);
});

/**
 * GET /api/downloads/info/:trackId
 * Returns estimated/actual size for compressed download.
 */
downloadsRouter.get("/info/:trackId", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  if (!safeTrackId(trackId)) return c.json({ error: "Invalid track ID" }, 400);
  const bitrate = Math.min(256, Math.max(64, Number(c.req.query("bitrate") ?? 128)));
  const db = getDb();
  const track = db.prepare("SELECT id, duration, source FROM tracks WHERE id = $id").get({ $id: trackId }) as {
    id: string; duration: number; source: string;
  } | null;

  if (!track) return c.json({ error: "Track not found" }, 404);

  const CACHE_DIR = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads");
  const compressedPath = path.join(CACHE_DIR, "compressed", `${safeCacheKey(trackId)}_${bitrate}.m4a`);

  if (fs.existsSync(compressedPath)) {
    const stat = fs.statSync(compressedPath);
    return c.json({ trackId, sizeBytes: stat.size, cached: true, bitrate });
  }

  const estimatedBytes = Math.ceil((bitrate * 1000 * track.duration) / 8) + 50_000;
  return c.json({ trackId, sizeBytes: estimatedBytes, cached: false, bitrate });
});
