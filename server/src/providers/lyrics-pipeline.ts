/**
 * AI Lyrics Pipeline Orchestrator
 *
 * Strategy (in priority order):
 *   1. whisper.cpp local — fast (~15-25s on Apple Silicon), native --output-lrc
 *   2. OpenRouter (Gemini Flash) — cloud fallback (~15-30s, needs API key)
 *
 * Install whisper.cpp:
 *   brew install whisper-cpp
 *   whisper-cpp-download-ggml-model large-v3-turbo
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, execFile } from "child_process";
import { getDb } from "../db/index.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const AUDIO_MODEL = "google/gemini-3.1-flash-lite-preview";

// Cache binary/tool detection — avoids repeated `which` + `fs.existsSync` per request
let _whisperBin: string | null | undefined;
let _whisperModel: string | null | undefined;
let _ffmpegAvailable: boolean | undefined;

interface PipelineJob {
  trackId: string;
  status: "pending" | "running" | "done" | "failed";
  startedAt: number;
  error?: string;
}

const jobs = new Map<string, PipelineJob>();

// Clean up completed/failed jobs older than 10 min; cap at 200 entries
setInterval(() => {
  const cutoff = Date.now() - 600_000;
  for (const [id, job] of jobs) {
    if ((job.status === "done" || job.status === "failed") && job.startedAt < cutoff) {
      jobs.delete(id);
    }
  }
  // Hard cap: remove oldest entries if map grows too large
  if (jobs.size > 200) {
    const sorted = [...jobs.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (let i = 0; i < sorted.length - 200; i++) {
      jobs.delete(sorted[i][0]);
    }
  }
}, 60_000);

export function getJobStatus(trackId: string): PipelineJob | null {
  return jobs.get(trackId) ?? null;
}

/** Detect which local whisper binary is available (result cached for process lifetime) */
function findWhisperCpp(): string | null {
  if (_whisperBin !== undefined) return _whisperBin;
  for (const bin of ["whisper-cpp", "whisper.cpp", "main"]) {
    try {
      const p = execFileSync("which", [bin], { stdio: "pipe" }).toString().trim();
      if (p) { _whisperBin = p; return p; }
    } catch {}
  }
  _whisperBin = null;
  return null;
}

/** Find the best whisper model available (result cached for process lifetime) */
function findWhisperModel(): string | null {
  if (_whisperModel !== undefined) return _whisperModel;
  if (process.env.WHISPER_MODEL_PATH && fs.existsSync(process.env.WHISPER_MODEL_PATH)) {
    _whisperModel = process.env.WHISPER_MODEL_PATH;
    return _whisperModel;
  }
  // Homebrew default locations
  const prefixes = ["/opt/homebrew", "/usr/local"];
  const models = ["ggml-large-v3-turbo.bin", "ggml-large-v3.bin", "ggml-medium.bin", "ggml-base.bin"];
  for (const prefix of prefixes) {
    for (const model of models) {
      const p = `${prefix}/share/whisper-cpp/models/${model}`;
      if (fs.existsSync(p)) { _whisperModel = p; return p; }
    }
  }
  _whisperModel = null;
  return null;
}

function isWhisperCppReady(): boolean {
  return !!findWhisperCpp() && !!findWhisperModel();
}

function isFfmpegAvailable(): boolean {
  if (_ffmpegAvailable !== undefined) return _ffmpegAvailable;
  try {
    execFileSync("which", ["ffmpeg"], { stdio: "pipe" });
    _ffmpegAvailable = true;
  } catch {
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}

export async function getPipelineStatus(): Promise<{ ready: boolean; method?: string; error?: string }> {
  if (isWhisperCppReady()) {
    return { ready: true, method: "whisper-cpp" };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return { ready: true, method: "openrouter" };
  }
  return {
    ready: false,
    error: "Install whisper.cpp (brew install whisper-cpp && whisper-cpp-download-ggml-model large-v3-turbo) or set OPENROUTER_API_KEY",
  };
}

export function listJobs(): PipelineJob[] {
  return Array.from(jobs.values());
}

export function startTranscription(trackId: string, audioPath: string): PipelineJob {
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

  runPipeline(trackId, audioPath, job).catch((err: unknown) => {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    console.error(`[lyrics-pipeline] Job ${trackId} failed:`, job.error);
  });

  return job;
}

async function runPipeline(trackId: string, audioPath: string, job: PipelineJob): Promise<void> {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  console.log(`[lyrics-pipeline] Starting job for ${trackId} (audio: ${audioPath})`);

  const db = getDb();
  const trackInfo = db.prepare("SELECT title, artist, duration FROM tracks WHERE id = $id").get({ $id: trackId }) as {
    title?: string;
    artist?: string;
    duration?: number;
  } | null;
  const title = trackInfo?.title ?? "Unknown";
  const artist = trackInfo?.artist ?? "Unknown";

  let lrc: string | null = null;

  // Strategy 1: whisper.cpp (local, fast, free)
  if (isWhisperCppReady() && isFfmpegAvailable()) {
    try {
      lrc = await transcribeWithWhisperCpp(audioPath);
    } catch (e) {
      console.warn(`[lyrics-pipeline] whisper.cpp failed:`, e instanceof Error ? e.message : e);
    }
  }

  // Strategy 2: OpenRouter (cloud AI)
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!lrc && openrouterKey) {
    try {
      lrc = await transcribeWithOpenRouter(audioPath, title, artist, openrouterKey);
    } catch (e) {
      console.warn(`[lyrics-pipeline] OpenRouter failed:`, e instanceof Error ? e.message : e);
    }
  }

  if (!lrc) {
    throw new Error(
      isWhisperCppReady()
        ? "Transcription failed. Make sure ffmpeg is installed (brew install ffmpeg)."
        : "No transcription method available. Install whisper.cpp or set OPENROUTER_API_KEY."
    );
  }

  // Cache in DB
  db.prepare(`
    INSERT INTO lyrics_cache (track_id, lrc, source)
    VALUES ($id, $lrc, 'ai')
    ON CONFLICT(track_id) DO UPDATE SET lrc = excluded.lrc, source = excluded.source, created_at = unixepoch()
  `).run({ $id: trackId, $lrc: lrc });

  job.status = "done";
  const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
  console.log(`[lyrics-pipeline] Job ${trackId} completed in ${elapsed}s (${lrc.split("\n").length} lines)`);
}

// ── whisper.cpp local transcription ──────────────────────────────────────────

async function transcribeWithWhisperCpp(audioPath: string): Promise<string> {
  const whisperBin = findWhisperCpp()!;
  const modelPath = findWhisperModel()!;

  console.log(`[lyrics-pipeline] Using whisper.cpp: ${whisperBin} (model: ${path.basename(modelPath)})`);

  // whisper.cpp requires 16kHz mono WAV — convert with ffmpeg
  const tmpWav = path.join(os.tmpdir(), `musaic-lyrics-${Date.now()}.wav`);

  try {
    await convertToWav(audioPath, tmpWav);
    const lrc = await runWhisperCpp(whisperBin, modelPath, tmpWav);
    return lrc;
  } finally {
    // Clean up temp files
    for (const f of [tmpWav, `${tmpWav}.lrc`]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", outputPath],
      { timeout: 30_000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`ffmpeg conversion failed: ${(stderr || err.message).slice(0, 200)}`));
        else resolve();
      }
    );
  });
}

function runWhisperCpp(bin: string, model: string, wavPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use all available threads; beam-size 1 + best-of 1 cuts search time ~30-40%
    const threads = String(Math.max(4, Math.min(os.cpus().length, 8)));
    execFile(
      bin,
      [
        "-m", model,
        "-f", wavPath,
        "--output-lrc",
        "--max-len", "42",
        "-l", "auto",
        "--no-prints",
        "--threads", threads,
        "--beam-size", "1",
        "--best-of", "1",
      ],
      {
        timeout: 90_000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GGML_METAL_PATH_RESOURCES: process.env.GGML_METAL_PATH_RESOURCES ?? "/opt/homebrew/share/whisper-cpp",
        },
      },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`whisper.cpp failed: ${(stderr || err.message).slice(0, 300)}`));
          return;
        }
        // whisper.cpp writes <input>.lrc
        const lrcPath = `${wavPath}.lrc`;
        if (!fs.existsSync(lrcPath)) {
          reject(new Error("whisper.cpp did not produce LRC output"));
          return;
        }
        const lrc = fs.readFileSync(lrcPath, "utf-8").trim();
        if (!lrc) {
          reject(new Error("whisper.cpp produced empty LRC output"));
          return;
        }
        resolve(lrc);
      }
    );
  });
}

// ── OpenRouter cloud transcription ───────────────────────────────────────────

async function transcribeWithOpenRouter(
  audioPath: string,
  title: string,
  artist: string,
  apiKey: string,
): Promise<string> {
  const fileSize = fs.statSync(audioPath).size;
  if (fileSize > 25 * 1024 * 1024) {
    throw new Error("Audio file is too large for cloud transcription fallback (>25MB)");
  }

  const audioBuffer = fs.readFileSync(audioPath);
  const audioBase64 = audioBuffer.toString("base64");

  const ext = path.extname(audioPath).toLowerCase();

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AUDIO_MODEL,
      messages: [
        {
          role: "system",
          content: `You are a professional music transcription assistant. You transcribe song lyrics with precise timestamps in LRC format. Rules:
- Output ONLY LRC format lines: [mm:ss.xx] Lyric text
- Every line must have a timestamp
- Timestamps must be accurate to the actual moment each line is sung
- Include all lyrics including repeated choruses
- If a line has backing vocals, include them in parentheses
- Do NOT include any metadata tags, comments or explanations
- Start timestamps from when singing actually begins, not from 00:00`,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Transcribe the lyrics of "${title}" by "${artist}" from this audio. Output only LRC format.`,
            },
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format: ext.replace(".", "") || "mp3",
              },
            },
          ],
        },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) throw new Error(`OpenRouter error: ${data.error.message}`);

  const lrc = data.choices?.[0]?.message?.content?.trim();
  if (!lrc) throw new Error("No lyrics returned from AI model");

  return cleanLrcOutput(lrc);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanLrcOutput(raw: string): string {
  let lines = raw
    .replace(/```[a-z]*\n?/g, "")
    .replace(/```/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  lines = lines.filter((l) => !l.match(/^\[(ti|ar|al|by|offset|re|ve|length):/i));

  const lrcLines = lines.filter((l) => l.match(/^\[\d{1,2}:\d{2}\.\d{1,3}\]/));
  if (lrcLines.length > 0) return lrcLines.join("\n");

  return lines.join("\n");
}
