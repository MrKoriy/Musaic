/**
 * Lyrics routes
 *
 * GET  /api/lyrics/:trackId         — get cached lyrics or fetch from LRCLIB → Genius → lyrics.ovh
 * POST /api/lyrics/:trackId/generate — trigger AI pipeline (async)
 * GET  /api/lyrics/:trackId/status   — poll AI job status
 * GET  /api/lyrics/:trackId/events   — AI job status as server-sent events
 * PUT  /api/lyrics/:trackId/offset   — store the user's highlight offset
 * PUT  /api/lyrics/:trackId          — save manually edited lyrics
 * DELETE /api/lyrics/:trackId        — clear cached lyrics
 * POST /api/lyrics/prefetch-all      — background pre-fetch for all tracks without lyrics
 */

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getCachedLyrics, setCachedLyrics, deleteCachedLyrics, getTrack, upsertTrack } from "../db/index.js";
import { fetchLrclib, searchLrclib } from "../providers/lrclib.js";
import { fetchPlainLyrics } from "../providers/genius.js";
import {
  getJobStatus,
  getPipelineStatus,
  LYRICS_GENERATE_TASK,
  lyricsTaskKey,
  pipelineJobFromTask,
  startTranscription,
  type PipelineJob,
} from "../providers/lyrics-pipeline.js";
import { onTaskUpdate } from "../jobs/tasks.js";
import { requestUserId } from "../middleware/auth.js";
import { enqueueLyricsPrefetch, tracksMissingLyrics } from "../jobs/lyrics-prefetch.js";
import { getDb } from "../db/index.js";
import { getSoundCloudProvider } from "../providers/soundcloud.js";
import { getVKProvider } from "../providers/vk.js";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { resolveAllowedLocalFile } from "../utils/stream-proxy.js";

const router = new Hono();
const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads");

/**
 * Highlight lead the client should apply for a lyrics source.
 *
 * Human-typed LRC (LRCLIB) consistently runs behind the audio, so the client
 * highlights ~0.4s early. Our own forced alignment already bakes in a
 * perceptual lead, raw whisper transcription needs only a small nudge.
 */
function offsetForSource(source: string): number {
  if (source === "aligned") return 0;
  if (source === "ai") return 0.15;
  return 0.4; // lrclib & co — human-typed timestamps lag behind the vocal
}

/** Parse stored word timings JSON without letting bad rows break the response. */
function parseWords(words: string | null | undefined): unknown[] | null {
  if (!words) return null;
  try {
    const parsed = JSON.parse(words);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const MAX_USER_OFFSET_SEC = 5;

function userOffsetFor(c: Context, trackId: string): number {
  const userId = requestUserId(c);
  if (!userId) return 0;
  const row = getDb().prepare(`
    SELECT offset_sec FROM lyrics_user_offsets WHERE user_id = $user AND track_id = $track
  `).get({ $user: userId, $track: trackId }) as { offset_sec: number } | null;
  return row ? Number(row.offset_sec) : 0;
}

/** Clamp to ±5 s and round to 50 ms, the slider's step. */
export function normalizeUserOffset(value: number): number {
  const clamped = Math.max(-MAX_USER_OFFSET_SEC, Math.min(MAX_USER_OFFSET_SEC, value));
  return Math.round(clamped * 20) / 20 || 0;
}

function getSafeTrackAudioPath(trackId: string): string | null {
  const track = getTrack(trackId) as {
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    cover_url?: string;
    local_path?: string;
    source?: string;
  } | null;
  if (!track?.local_path) return null;

   return resolveAllowedLocalFile(track.local_path);
}

/**
 * GET /api/lyrics/pipeline/ready — check if AI pipeline dependencies are available
 */
router.get("/pipeline/ready", async (c) => {
  const status = await getPipelineStatus();
  return c.json(status, status.ready ? 200 : 503);
});

/**
 * GET /api/lyrics/:trackId?artist=&title=&duration=
 *
 * Fetch chain:
 *   1. SQLite cache (instant)
 *   2. LRCLIB exact match (synced LRC preferred)
 *   3. LRCLIB search fallback
 *   4. Genius API or lyrics.ovh (plain text, no timestamps)
 *   5. Return null — client should trigger /generate
 */
router.get("/:trackId", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));

  // 1. Cache hit
  const cached = getCachedLyrics(trackId);
  if (cached) {
    return c.json({
      trackId,
      lrc: cached.lrc,
      source: cached.source,
      words: parseWords(cached.words),
      offsetSec: offsetForSource(cached.source),
      userOffsetSec: userOffsetFor(c, trackId),
      cached: true,
    });
  }

  // 2. Resolve artist/title
  const artist = c.req.query("artist") ?? "";
  const title = c.req.query("title") ?? "";
  const duration = c.req.query("duration") ? Number(c.req.query("duration")) : undefined;

  if (!artist || !title) {
    const track = getTrack(trackId) as { artist?: string; title?: string; duration?: number } | null;
    if (!track) {
      return c.json({ trackId, lrc: null, source: null, cached: false });
    }
    return fetchAndRespond(c, trackId, track.artist ?? "", track.title ?? "", track.duration);
  }

  return fetchAndRespond(c, trackId, artist, title, duration);
});

async function fetchAndRespond(
  c: Context,
  trackId: string,
  artist: string,
  title: string,
  duration?: number
) {
  // 1. LRCLIB exact match
  let result = await fetchLrclib(artist, title, duration);

  // 2. LRCLIB search fallback
  if (!result) {
    result = await searchLrclib(`${artist} ${title}`);
  }

  if (result) {
    setCachedLyrics(trackId, result.lrc, result.source);
    return c.json({
      trackId,
      lrc: result.lrc,
      source: result.source,
      words: null,
      offsetSec: offsetForSource(result.source),
      userOffsetSec: userOffsetFor(c, trackId),
      cached: false,
    });
  }

  // 3. Genius / lyrics.ovh plain-text fallback
  const plain = await fetchPlainLyrics(artist, title);
  if (plain) {
    setCachedLyrics(trackId, plain.lyrics, plain.source);
    return c.json({
      trackId,
      lrc: plain.lyrics,
      source: plain.source,
      words: null,
      offsetSec: offsetForSource(plain.source),
      userOffsetSec: userOffsetFor(c, trackId),
      cached: false,
    });
  }

  return c.json({ trackId, lrc: null, source: null, cached: false });
}

/**
 * POST /api/lyrics/:trackId/generate
 * Starts async AI pipeline from a trusted track file or server-side download.
 */
router.post("/:trackId/generate", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  if (!trackId || /[\\/]|\.\./.test(trackId) || trackId.length > 256) {
    return c.json({ error: "Invalid track ID" }, 400);
  }
  await c.req.json().catch(() => null);

  const track = getTrack(trackId) as {
    id?: string;
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    cover_url?: string;
    local_path?: string;
    source?: string;
  } | null;

  let audioPath = getSafeTrackAudioPath(trackId) ?? undefined;

  if (!audioPath && track) {
    try {
      if (trackId.startsWith("vk_") && getVKProvider().isAuthenticated()) {
        audioPath = await getVKProvider().downloadTrack(trackId, DOWNLOADS_DIR);
      } else if (trackId.startsWith("sc_")) {
        const streamUrl = await getSoundCloudProvider().getStreamUrl(trackId);
        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const filename = `${trackId}.mp3`;
        const localPath = path.join(DOWNLOADS_DIR, filename);

        if (!fs.existsSync(localPath)) {
          const res = await fetch(streamUrl, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) throw new Error(`Download failed: ${res.status}`);

          if (!res.body) throw new Error("No body");
          // Temp file + rename: a cut-off download must never pass as the track.
          const tmpPath = `${localPath}.${process.pid}.${Date.now()}.part`;
          try {
            await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmpPath));
            fs.renameSync(tmpPath, localPath);
          } finally {
            fs.rmSync(tmpPath, { force: true });
          }
        }

        upsertTrack({
          id: trackId,
          source: "soundcloud",
          title: track.title ?? "Unknown Title",
          artist: track.artist ?? "Unknown Artist",
          album: track.album,
          duration: Math.round(track.duration ?? 0),
          cover_url: track.cover_url,
          local_path: localPath,
        });
        audioPath = localPath;
      }
    } catch (e) {
      console.error("[lyrics] Auto-download failed:", e);
    }
  }

  if (!audioPath) {
    return c.json({ error: "Could not download track for lyrics generation." }, 400);
  }

  const job = startTranscription(trackId, audioPath);
  return c.json({ trackId, status: job.status, startedAt: job.startedAt });
});

function currentJobStatus(trackId: string): { status: string; error?: string; startedAt?: number; cached?: boolean } {
  const job = getJobStatus(trackId);
  if (job) return { status: job.status, startedAt: job.startedAt, ...(job.error ? { error: job.error } : {}) };
  if (getCachedLyrics(trackId)) return { status: "done", cached: true };
  return { status: "not_started" };
}

function isTerminal(status: string): boolean {
  return status === "done" || status === "failed" || status === "not_started";
}

/**
 * GET /api/lyrics/:trackId/status — poll AI transcription job
 */
router.get("/:trackId/status", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  return c.json({ trackId, ...currentJobStatus(trackId) });
});

const SSE_HEARTBEAT_MS = 8_000; // under Bun.serve's 10 s idle timeout
const SSE_MAX_DURATION_MS = 200_000; // client gives up after 180 s

/**
 * GET /api/lyrics/:trackId/events — the AI job status as server-sent events.
 * Emits `event: status` with `{ status, error? }` now and on every change and
 * closes after a terminal state, replacing the client's 2 s polling loop.
 */
router.get("/:trackId/events", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const key = lyricsTaskKey(trackId);
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    const send = (payload: { status: string; error?: string }) =>
      stream.writeSSE({ event: "status", data: JSON.stringify({ trackId, ...payload }) });

    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const updates: PipelineJob[] = [];
    let wake: (() => void) | null = null;

    const unsubscribe = onTaskUpdate((task) => {
      if (task.dedupeKey !== key || task.type !== LYRICS_GENERATE_TASK) return;
      updates.push(pipelineJobFromTask(task));
      wake?.();
    });
    const heartbeat = setInterval(() => {
      void stream.write(": ping\n\n").catch(() => finish());
    }, SSE_HEARTBEAT_MS);
    const deadline = setTimeout(() => finish(), SSE_MAX_DURATION_MS);
    stream.onAbort(() => finish());

    try {
      const initial = currentJobStatus(trackId);
      await send(initial);
      if (isTerminal(initial.status)) return;

      let last = initial.status;
      while (!stream.aborted) {
        const next = updates.shift();
        if (!next) {
          const woke = new Promise<"update">((resolve) => { wake = () => resolve("update"); });
          if ((await Promise.race([woke, finished.then(() => "done" as const)])) === "done") break;
          wake = null;
          continue;
        }
        if (next.status === last && next.status !== "failed") continue;
        last = next.status;
        await send({ status: next.status, ...(next.error ? { error: next.error } : {}) });
        if (next.status === "done" || next.status === "failed") break;
      }
    } finally {
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
  });
});

/**
 * PUT /api/lyrics/:trackId/offset — the user's highlight fine-tuning.
 * Body: { userOffsetSec: number } (clamped to ±5 s, 50 ms steps; 0 clears it)
 */
router.put("/:trackId/offset", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const userId = requestUserId(c);
  if (!userId) return c.json({ error: "Not authenticated" }, 401);
  if (!trackId || trackId.length > 256) return c.json({ error: "Invalid track ID" }, 400);

  const body = await c.req.json<{ userOffsetSec?: unknown }>().catch(() => null);
  const raw = typeof body?.userOffsetSec === "number" ? body.userOffsetSec : Number.NaN;
  if (!Number.isFinite(raw)) return c.json({ error: "userOffsetSec must be a number" }, 400);

  const offset = normalizeUserOffset(raw);
  const db = getDb();
  if (offset === 0) {
    db.prepare("DELETE FROM lyrics_user_offsets WHERE user_id = $user AND track_id = $track")
      .run({ $user: userId, $track: trackId });
  } else {
    db.prepare(`
      INSERT INTO lyrics_user_offsets (user_id, track_id, offset_sec, updated_at)
      VALUES ($user, $track, $offset, unixepoch())
      ON CONFLICT(user_id, track_id) DO UPDATE SET offset_sec = excluded.offset_sec, updated_at = unixepoch()
    `).run({ $user: userId, $track: trackId, $offset: offset });
  }
  return c.json({ ok: true, trackId, userOffsetSec: offset });
});

/**
 * PUT /api/lyrics/:trackId — save manually edited lyrics
 * Body: { lrc: string }
 */
router.put("/:trackId", async (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  const body = await c.req.json<{ lrc: string }>();
  if (!body.lrc) return c.json({ error: "lrc required" }, 400);

  setCachedLyrics(trackId, body.lrc, "manual");
  return c.json({ ok: true, trackId, source: "manual" });
});

/**
 * DELETE /api/lyrics/:trackId — clear cached lyrics
 */
router.delete("/:trackId", (c) => {
  const trackId = decodeURIComponent(c.req.param("trackId"));
  deleteCachedLyrics(trackId);
  return c.json({ ok: true, trackId });
});

/**
 * POST /api/lyrics/prefetch-all
 * Queue a durable background prefetch for local tracks without cached lyrics.
 */
router.post("/prefetch-all", (c) => {
  const total = tracksMissingLyrics().length;
  if (total === 0) {
    return c.json({ ok: true, queued: 0, message: "All local tracks already have lyrics cached" });
  }
  enqueueLyricsPrefetch();
  return c.json({ ok: true, queued: total, message: `Prefetching lyrics for ${total} tracks in background` });
});

export default router;
