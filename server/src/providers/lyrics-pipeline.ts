/**
 * AI Lyrics Pipeline Orchestrator
 *
 * Orchestrates: Demucs vocal separation → Parakeet TDT v3 ASR → LLM cleanup → LRC
 *
 * The heavy lifting is done by server/scripts/transcribe.py (Python).
 * This module spawns the Python process and manages the output.
 *
 * Processing time: ~3-5 min per song on M1/M2 Mac (CPU/MPS)
 */

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { getDb } from "../db/index.js";

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = path.resolve(
  new URL("../../scripts/transcribe.py", import.meta.url).pathname
);

interface PipelineJob {
  trackId: string;
  status: "pending" | "running" | "done" | "failed";
  startedAt: number;
  error?: string;
}

// In-memory job registry (one job at a time to avoid OOM on personal Mac)
const jobs = new Map<string, PipelineJob>();

export function getJobStatus(trackId: string): PipelineJob | null {
  return jobs.get(trackId) ?? null;
}

export function listJobs(): PipelineJob[] {
  return Array.from(jobs.values());
}

/**
 * Start AI transcription pipeline for a track.
 * Returns immediately — poll getJobStatus() for result.
 * On success, saves LRC to lyrics_cache in DB.
 */
export function startTranscription(
  trackId: string,
  audioPath: string
): PipelineJob {
  const existing = jobs.get(trackId);
  if (existing && (existing.status === "running" || existing.status === "done")) {
    return existing;
  }

  const job: PipelineJob = {
    trackId,
    status: "running",
    startedAt: Date.now(),
  };
  jobs.set(trackId, job);

  // Run async — do not await
  runPipeline(trackId, audioPath, job).catch((err: unknown) => {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    console.error(`[lyrics-pipeline] Job ${trackId} failed:`, job.error);
  });

  return job;
}

async function runPipeline(
  trackId: string,
  audioPath: string,
  job: PipelineJob
): Promise<void> {
  const pythonPath = process.env.PYTHON_PATH ?? "python3";
  const openrouterKey = process.env.OPENROUTER_API_KEY ?? "";

  // Output LRC to a temp file, then read it back
  const lrcPath = path.join(
    process.env.DOWNLOADS_DIR ?? "downloads",
    `${trackId}.lrc`
  );

  console.log(`[lyrics-pipeline] Starting job for ${trackId} (audio: ${audioPath})`);

  try {
    const args = [SCRIPT_PATH, audioPath, lrcPath];
    if (openrouterKey) {
      args.push("--openrouter-key", openrouterKey);
    }

    const { stdout, stderr } = await execFileAsync(pythonPath, args, {
      timeout: 15 * 60 * 1000, // 15 min max
      maxBuffer: 10 * 1024 * 1024, // 10MB stdout buffer
    });

    if (stderr) {
      console.warn(`[lyrics-pipeline] stderr:`, stderr.slice(0, 500));
    }

    // Read the LRC file
    let lrc: string;
    if (fs.existsSync(lrcPath)) {
      lrc = fs.readFileSync(lrcPath, "utf-8").trim();
    } else {
      // Fallback: parse from stdout
      lrc = extractLrcFromStdout(stdout);
    }

    if (!lrc) {
      throw new Error("No LRC output from pipeline");
    }

    // Cache in DB
    const db = getDb();
    db.prepare(`
      INSERT INTO lyrics_cache (track_id, lrc, source)
      VALUES ($id, $lrc, 'ai')
      ON CONFLICT(track_id) DO UPDATE SET lrc = excluded.lrc, source = excluded.source, created_at = unixepoch()
    `).run({ $id: trackId, $lrc: lrc });

    job.status = "done";
    console.log(`[lyrics-pipeline] Job ${trackId} completed (${lrc.split("\n").length} lines)`);
  } catch (err: unknown) {
    throw err;
  }
}

/** Extract LRC content from script stdout (printed after "[transcribe] Done" line) */
function extractLrcFromStdout(stdout: string): string {
  const doneIdx = stdout.indexOf("[transcribe] Done");
  if (doneIdx !== -1) {
    return stdout.slice(0, doneIdx).trim();
  }
  // Try to find LRC-format lines
  const lrcLines = stdout
    .split("\n")
    .filter((line) => /^\[\d{2}:\d{2}/.test(line));
  return lrcLines.join("\n");
}
