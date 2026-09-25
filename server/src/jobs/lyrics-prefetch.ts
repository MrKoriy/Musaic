/**
 * Background lyrics prefetch for local tracks without cached lyrics, run on
 * the durable task queue so a restart does not drop a half-finished batch.
 */
import { getCachedLyrics, getDb, setCachedLyrics } from "../db/index.js";
import { log } from "../logger.js";
import { fetchLrclib, searchLrclib } from "../providers/lrclib.js";
import { fetchPlainLyrics } from "../providers/genius.js";
import { enqueueTask, registerTaskHandler, type TaskContext, type TaskRecord } from "./tasks.js";

export const LYRICS_PREFETCH_TASK = "lyrics.prefetch";
const PREFETCH_BATCH = 200;
const REQUEST_GAP_MS = 300;

interface PrefetchTrack {
  id: string;
  artist: string;
  title: string;
  duration: number;
}

export function tracksMissingLyrics(limit = PREFETCH_BATCH): PrefetchTrack[] {
  return getDb().prepare(`
    SELECT t.id, t.artist, t.title, t.duration
    FROM tracks t
    WHERE t.source = 'local'
      AND NOT EXISTS (SELECT 1 FROM lyrics_cache lc WHERE lc.track_id = t.id)
    LIMIT $limit
  `).all({ $limit: limit }) as PrefetchTrack[];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function prefetchOne(track: PrefetchTrack): Promise<boolean> {
  const synced = (await fetchLrclib(track.artist, track.title, track.duration))
    ?? (await searchLrclib(`${track.artist} ${track.title}`));
  if (synced) {
    setCachedLyrics(track.id, synced.lrc, synced.source);
    return true;
  }
  const plain = await fetchPlainLyrics(track.artist, track.title);
  if (plain) {
    setCachedLyrics(track.id, plain.lyrics, plain.source);
    return true;
  }
  return false;
}

export async function runLyricsPrefetch(_payload: unknown, ctx: TaskContext): Promise<{ fetched: number; missed: number }> {
  const tracks = tracksMissingLyrics();
  log.info("lyrics", `prefetch started for ${tracks.length} tracks`);
  let fetched = 0;
  let missed = 0;
  for (const track of tracks) {
    // Abort means shutdown: throw so the queue re-runs the batch on next start.
    if (ctx.signal.aborted) throw new Error("prefetch interrupted by shutdown");
    if (!track.artist || !track.title || getCachedLyrics(track.id)) continue;
    try {
      if (await prefetchOne(track)) fetched++;
      else missed++;
    } catch (error) {
      missed++;
      log.warn("lyrics", `prefetch failed for "${track.artist} - ${track.title}":`, error instanceof Error ? error.message : String(error));
    }
    await sleep(REQUEST_GAP_MS, ctx.signal);
  }
  log.info("lyrics", `prefetch done — fetched: ${fetched}, not found: ${missed}`);
  return { fetched, missed };
}

export function registerLyricsPrefetchHandler(): void {
  registerTaskHandler(LYRICS_PREFETCH_TASK, runLyricsPrefetch, { concurrency: 1, leaseSeconds: 300 });
}

export function enqueueLyricsPrefetch(): TaskRecord {
  registerLyricsPrefetchHandler();
  return enqueueTask(LYRICS_PREFETCH_TASK, {}, { dedupeKey: "lyrics-prefetch:all", maxAttempts: 3 });
}
