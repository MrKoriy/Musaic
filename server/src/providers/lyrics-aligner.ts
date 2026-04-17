/**
 * Forced-Alignment Lyrics Aligner
 *
 * Given:
 *   - audio file (mp3/flac/etc.)
 *   - reference lyrics plain text (one line per lyric line, from LRCLIB / Genius)
 *
 * Produces:
 *   - LRC with accurate per-line timestamps, mapped from whisper word-level output
 *     to reference text via sequence alignment.
 *
 * This is a CPU-only forced-alignment approximation that's dramatically more
 * accurate than raw LRCLIB timestamps (which are human-typed with reaction-time
 * lag) and much faster than running full WhisperX / SOFA on a low-end VPS.
 *
 * Pipeline:
 *   1. ffmpeg converts audio → 16kHz mono WAV
 *   2. whisper.cpp with `--max-len 1` produces a JSON file with one
 *      segment per transcribed word, each carrying start/end offsets (ms).
 *   3. Reference lyrics are tokenised into words + line index.
 *   4. Global sequence alignment (Needleman-Wunsch-like) maps reference words
 *      onto whisper words by case-folded fuzzy equality.
 *   5. For each reference *line*, we pick the earliest matched word's timestamp
 *      as the line's start time. Missing lines are interpolated between known
 *      neighbours so the scroll still moves smoothly.
 *   6. Output LRC: `[mm:ss.xx] line text`
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";

interface WhisperWord {
  text: string;
  from: number; // ms
  to: number;   // ms
}

interface ReferenceToken {
  line: number; // index of the line this word belongs to
  word: string; // normalized word
}

export interface AlignOptions {
  whisperBin: string;
  whisperModel: string;
  /** Optional override of working temp dir. */
  tmpDir?: string;
  /** "auto" for detection, or ISO 639-1 code ("en", "ru", …). Default: "auto". */
  language?: string;
  /** Seconds to subtract from each final timestamp so the line appears slightly
   *  before the vowel onset — matches Apple Music's perceptual lead.
   *  Default 0.15. */
  perceptualLeadSec?: number;
}

/**
 * Run the full alignment pipeline. Returns LRC string on success.
 * Throws on fatal errors (ffmpeg missing, whisper binary missing, empty refText).
 */
export async function alignLyricsWithWhisper(
  audioPath: string,
  referenceText: string,
  opts: AlignOptions
): Promise<string> {
  const lines = referenceText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) throw new Error("Reference lyrics are empty");

  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const base = `musaic-align-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wavPath = path.join(tmpDir, `${base}.wav`);
  const jsonPath = path.join(tmpDir, `${base}`); // whisper appends .json

  try {
    await convertToWav(audioPath, wavPath);
    await runWhisperWordLevel(wavPath, jsonPath, opts);
    const words = readWhisperWords(`${jsonPath}.json`);

    if (words.length === 0) {
      throw new Error("whisper produced no usable words");
    }

    const lineStarts = alignReferenceToWhisper(lines, words);

    const lead = opts.perceptualLeadSec ?? 0.15;

    return formatLrc(lines, lineStarts, lead);
  } finally {
    for (const f of [wavPath, `${jsonPath}.json`]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

// ── 1. ffmpeg conversion ─────────────────────────────────────────────────────

function convertToWav(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", output],
      { timeout: 45_000 },
      (err, _o, stderr) => {
        if (err) reject(new Error(`ffmpeg failed: ${(stderr || err.message).slice(0, 200)}`));
        else resolve();
      }
    );
  });
}

// ── 2. whisper.cpp word-level transcription ──────────────────────────────────

function runWhisperWordLevel(
  wavPath: string,
  outBase: string,
  opts: AlignOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    const threads = String(Math.max(2, Math.min(os.cpus().length, 4)));
    const args = [
      "-m", opts.whisperModel,
      "-f", wavPath,
      "--output-json-full",
      "--output-file", outBase,
      "--max-len", "1",
      "-l", opts.language ?? "auto",
      "--no-prints",
      "--threads", threads,
      "--beam-size", "1",
      "--best-of", "1",
    ];
    execFile(
      opts.whisperBin,
      args,
      { timeout: 180_000, maxBuffer: 20 * 1024 * 1024 },
      (err, _o, stderr) => {
        if (err) reject(new Error(`whisper failed: ${(stderr || err.message).slice(0, 300)}`));
        else resolve();
      }
    );
  });
}

function readWhisperWords(jsonPath: string): WhisperWord[] {
  if (!fs.existsSync(jsonPath)) return [];
  const raw = fs.readFileSync(jsonPath, "utf-8");
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const segs = parsed?.transcription ?? [];
  const out: WhisperWord[] = [];
  for (const seg of segs) {
    const text = String(seg?.text ?? "").trim();
    if (!text || text.startsWith("[")) continue;     // skip [_BEG_] / [_TT_x] etc.
    const from = Number(seg?.offsets?.from);
    const to = Number(seg?.offsets?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    // Occasionally a "word" comes back as multiple tokens like "it's" or "tryna" —
    // split further on whitespace so alignment has a 1-word granularity.
    for (const piece of text.split(/\s+/)) {
      const clean = piece.trim();
      if (clean) out.push({ text: clean, from, to });
    }
  }
  return out;
}

// ── 3. Reference tokenisation ────────────────────────────────────────────────

const PUNCT_RE = /[^\p{L}\p{N}']+/gu;

function normalizeWord(w: string): string {
  return w.normalize("NFKD").toLowerCase().replace(PUNCT_RE, "").replace(/'/g, "");
}

function tokenizeReference(lines: string[]): ReferenceToken[] {
  const tokens: ReferenceToken[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const w of lines[i].split(/\s+/)) {
      const norm = normalizeWord(w);
      if (norm) tokens.push({ line: i, word: norm });
    }
  }
  return tokens;
}

// ── 4. Alignment (greedy sliding-window + fuzzy match) ───────────────────────

/**
 * Given ordered reference tokens and ordered whisper words, return:
 *   map[lineIndex] → firstMatchedWordMs | null
 *
 * Strategy: walk both sequences forward. For each reference token, look in a
 * rolling window of upcoming whisper words (size 12). Pick the first word whose
 * normalised form equals the reference word OR has edit distance ≤ 1. Anchor
 * there and advance past that word.
 *
 * If nothing matches in the window, skip the reference token (we'll interpolate
 * the line's timestamp later if no other word in that line matched either).
 */
function alignReferenceToWhisper(
  lines: string[],
  whisper: WhisperWord[]
): Array<number | null> {
  const refTokens = tokenizeReference(lines);
  const lineStarts: Array<number | null> = Array(lines.length).fill(null);

  const normalizedWhisper = whisper.map((w) => ({ norm: normalizeWord(w.text), from: w.from }));

  let j = 0; // pointer into whisper words
  const WINDOW = 12;

  for (const ref of refTokens) {
    let bestIdx = -1;
    let bestScore = 999;

    for (let k = j; k < Math.min(j + WINDOW, normalizedWhisper.length); k++) {
      const cand = normalizedWhisper[k].norm;
      if (!cand) continue;
      if (cand === ref.word) {
        bestIdx = k;
        bestScore = 0;
        break;
      }
      // Tolerate 1-char edits for short words (typically mis-ASR)
      const d = editDistance(cand, ref.word, 1);
      if (d <= 1 && ref.word.length >= 3 && d < bestScore) {
        bestIdx = k;
        bestScore = d;
      }
    }

    if (bestIdx >= 0) {
      // Anchor: record earliest word per line (first one wins).
      if (lineStarts[ref.line] === null) {
        lineStarts[ref.line] = normalizedWhisper[bestIdx].from;
      }
      j = bestIdx + 1;
    }
  }

  // Interpolate lines that had zero matched words.
  interpolateGaps(lineStarts);

  return lineStarts;
}

/**
 * Bounded edit distance — returns Infinity once distance exceeds `maxD`.
 * We don't need full Levenshtein; cheap Hamming-esque check suffices for our
 * short tolerance window.
 */
function editDistance(a: string, b: string, maxD: number): number {
  if (Math.abs(a.length - b.length) > maxD) return Infinity;
  if (a === b) return 0;

  const m = a.length, n = b.length;
  if (Math.min(m, n) <= 1) return m + n; // degenerate; treat as mismatch

  // For single-edit tolerance: try same-length mismatch count OR off-by-one insertion/deletion.
  if (m === n) {
    let diff = 0;
    for (let i = 0; i < m; i++) if (a[i] !== b[i]) { diff++; if (diff > maxD) return Infinity; }
    return diff;
  }

  // |m-n| == 1 → check one insertion
  const [short, long] = m < n ? [a, b] : [b, a];
  let i = 0, j = 0, mismatches = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; }
    else { mismatches++; if (mismatches > maxD) return Infinity; j++; }
  }
  return mismatches + (long.length - j);
}

function interpolateGaps(lineStarts: Array<number | null>): void {
  // Linearly interpolate runs of null between two known timestamps.
  let i = 0;
  const n = lineStarts.length;
  while (i < n) {
    if (lineStarts[i] !== null) { i++; continue; }
    // find prev known
    let prev = i - 1;
    while (prev >= 0 && lineStarts[prev] === null) prev--;
    // find next known
    let next = i;
    while (next < n && lineStarts[next] === null) next++;

    if (prev < 0 && next >= n) {
      // Nothing matched — leave as null; formatter will fall back to 0.
      return;
    }

    if (prev < 0) {
      // Fill leading gap: stretch slightly before the first known time.
      const gap = next - i + 1;
      const step = 1500; // ~1.5s spacing for unknowns at the start
      for (let k = i; k < next; k++) {
        lineStarts[k] = Math.max(0, (lineStarts[next] as number) - (next - k) * step);
      }
    } else if (next >= n) {
      // Trailing gap: add fixed spacing after last known.
      const last = lineStarts[prev] as number;
      const step = 2000;
      for (let k = i; k < n; k++) lineStarts[k] = last + (k - prev) * step;
    } else {
      // Interior gap: linear interp.
      const a = lineStarts[prev] as number;
      const b = lineStarts[next] as number;
      const span = b - a;
      const steps = next - prev;
      for (let k = prev + 1; k < next; k++) {
        lineStarts[k] = a + Math.round(((k - prev) / steps) * span);
      }
    }
    i = next;
  }
}

// ── 5. LRC formatter ─────────────────────────────────────────────────────────

function formatLrc(lines: string[], starts: Array<number | null>, leadSec: number): string {
  const leadMs = Math.round(leadSec * 1000);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ms = Math.max(0, (starts[i] ?? 0) - leadMs);
    out.push(`${formatTimestamp(ms)} ${lines[i]}`);
  }
  return out.join("\n");
}

function formatTimestamp(ms: number): string {
  const totalCs = Math.round(ms / 10);
  const mm = Math.floor(totalCs / 6000);
  const ss = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}]`;
}
