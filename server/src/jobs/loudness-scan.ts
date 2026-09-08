import fs from "node:fs";
import { parseFile } from "music-metadata";
import { getDb } from "../db/index.js";
import { runFfmpeg } from "../utils/ffmpeg-queue.js";
import { log } from "../logger.js";

/**
 * Loudness scanner — measures integrated loudness (EBU R128 / LUFS) for every
 * track with a local file so the client can normalize playback volume
 * (ReplayGain-style). Two paths per track:
 *   1. Fast: reuse REPLAYGAIN_TRACK_GAIN tags when the file carries them.
 *   2. Accurate: `ffmpeg -af ebur128` measurement (fallback, and primary
 *      path for untagged files).
 *
 * The job is incremental: LOUDNESS_SCAN_LIMIT tracks per run; the scheduler
 * re-runs it hourly until the library is covered.
 */

export interface LoudnessScanResult {
  scanned: number;
  tagged: number;
  measured: number;
  missing: number;
  failed: number;
  remaining: number;
}

/** REPLAYGAIN_TRACK_GAIN is relative to 83 dB ≈ -18 LUFS (RG2 convention). */
export const RG_REFERENCE_LUFS = -18;

export interface Ebur128Summary {
  integratedLufs: number | null;
  peakDb: number | null;
}

/** Parse the ebur128 summary block ffmpeg writes at the end of stderr. */
export function parseEbur128Summary(stderr: string): Ebur128Summary {
  const summaryStart = stderr.lastIndexOf("Summary:");
  const summary = summaryStart >= 0 ? stderr.slice(summaryStart) : stderr;
  const integrated = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
  const peak = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(summary);
  return {
    integratedLufs: integrated ? Number(integrated[1]) : null,
    peakDb: peak ? Number(peak[1]) : null,
  };
}

/** Convert a ReplayGain tag pair into stored loudness fields. */
export function loudnessFromReplayGain(gainDb: number, peakDb: number | null): { lufs: number; peakDb: number | null } {
  return { lufs: RG_REFERENCE_LUFS - gainDb, peakDb };
}

function parseLimit(): number {
  const value = Number(process.env.LOUDNESS_SCAN_LIMIT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 200;
}

function isSaneLufs(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value > -60 && value < 0;
}

/** Read REPLAYGAIN tags; returns null when the file has none we trust. */
async function loudnessFromTags(file: string): Promise<{ lufs: number; peakDb: number | null } | null> {
  let gainDb: number | undefined;
  let peakDb: number | null = null;
  try {
    const meta = await parseFile(file, { skipCovers: true, duration: false });
    const common = meta.common as {
      replaygain_track_gain?: { dB?: number; ratio?: number };
      replaygain_track_peak?: { dB?: number; ratio?: number };
    };
    const taggedGain = common.replaygain_track_gain?.dB;
    if (typeof taggedGain === "number" && Number.isFinite(taggedGain)) {
      gainDb = taggedGain;
    }
    const taggedPeak = common.replaygain_track_peak;
    if (taggedPeak) {
      if (typeof taggedPeak.dB === "number" && Number.isFinite(taggedPeak.dB) && taggedPeak.dB !== 0) {
        peakDb = taggedPeak.dB;
      } else if (typeof taggedPeak.ratio === "number" && taggedPeak.ratio > 0) {
        peakDb = 20 * Math.log10(taggedPeak.ratio);
      }
    }
  } catch {
    return null; // unreadable tags — let ffmpeg try the audio itself
  }
  if (gainDb == null) return null;
  const { lufs } = loudnessFromReplayGain(gainDb, peakDb);
  if (!isSaneLufs(lufs)) return null;
  return { lufs, peakDb };
}

/** Measure integrated loudness with ffmpeg's ebur128 filter. */
async function measureWithFfmpeg(file: string): Promise<{ lufs: number; peakDb: number | null }> {
  const { stderr } = await runFfmpeg(
    ["-nostdin", "-hide_banner", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"],
    { timeoutMs: 120_000 },
  );
  const summary = parseEbur128Summary(stderr);
  if (!isSaneLufs(summary.integratedLufs)) {
    throw new Error(`ebur128 produced no integrated loudness for ${file}`);
  }
  return { lufs: summary.integratedLufs, peakDb: summary.peakDb };
}

export async function runLoudnessScanJob(): Promise<LoudnessScanResult> {
  const db = getDb();
  const limit = parseLimit();
  const rows = db.prepare(`
    SELECT id, local_path FROM tracks
    WHERE local_path IS NOT NULL AND loudness_scanned_at IS NULL
    ORDER BY updated_at DESC, id
    LIMIT $limit
  `).all({ $limit: limit }) as Array<{ id: string; local_path: string }>;

  const update = db.prepare(`
    UPDATE tracks
    SET loudness_lufs = $lufs, loudness_peak_db = $peak,
        loudness_source = $source, loudness_scanned_at = unixepoch()
    WHERE id = $id
  `);

  const result: LoudnessScanResult = { scanned: 0, tagged: 0, measured: 0, missing: 0, failed: 0, remaining: 0 };

  for (const row of rows) {
    const file = row.local_path;
    try {
      if (!fs.existsSync(file)) {
        update.run({ $id: row.id, $lufs: null, $peak: null, $source: "missing" });
        result.missing++;
        result.scanned++;
        continue;
      }

      const tagged = await loudnessFromTags(file);
      const outcome = tagged ?? await measureWithFfmpeg(file);
      if (tagged) result.tagged++; else result.measured++;

      update.run({ $id: row.id, $lufs: outcome.lufs, $peak: outcome.peakDb, $source: tagged ? "tag" : "ebur128" });
      result.scanned++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT")) {
        // ffmpeg is not installed — abort instead of poisoning every row as failed.
        throw new Error(`loudness scan requires ffmpeg: ${message}`);
      }
      update.run({ $id: row.id, $lufs: null, $peak: null, $source: "error" });
      result.failed++;
      result.scanned++;
      log.warn("jobs", `loudness scan failed for ${file}: ${message.slice(0, 200)}`);
    }
  }

  result.remaining = (db.prepare(`
    SELECT COUNT(*) AS n FROM tracks
    WHERE local_path IS NOT NULL AND loudness_scanned_at IS NULL
  `).get() as { n: number }).n;

  log.info(
    "jobs",
    `loudness scan: ${result.scanned} done (${result.tagged} tagged, ${result.measured} measured, ` +
      `${result.missing} missing, ${result.failed} failed), ${result.remaining} remaining`,
  );
  return result;
}
