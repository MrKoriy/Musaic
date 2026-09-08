import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDb, upsertTrack } from "../db/index.js";
import { setupTestDb } from "./setup.js";
import { parseEbur128Summary, loudnessFromReplayGain, runLoudnessScanJob } from "../jobs/loudness-scan.js";

const EBUR128_STDERR = `
  Input Integrated:   -70.0 LUFS / 0 dBFS
    Pk: -inf dBFS / -inf dBTP

  [Parsed_ebur128_0 @ 0x1234]
    Target:
      -23 LUFS

  Summary:

    Integrated loudness:
      I:         -14.5 LUFS
      Threshold: -25.68 LUFS

    Loudness range:
      LRA:        6.1 LU
      Threshold: -35.66 LUFS
      LRA low:   -20.2 LUFS
      LRA high:  -14.1 LUFS

    True peak:
      Peak:       -0.9 dBFS
`;

function makeSineWav(seconds = 2, freq = 440, sampleRate = 44100): Buffer {
  const samples = seconds * sampleRate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 12000);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function ffmpegAvailable(): boolean {
  try {
    execFileSync("which", ["ffmpeg"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("loudness scan", () => {
  test("parseEbur128Summary extracts I and Peak from the summary block", () => {
    const summary = parseEbur128Summary(EBUR128_STDERR);
    expect(summary.integratedLufs).toBe(-14.5);
    expect(summary.peakDb).toBe(-0.9);
  });

  test("parseEbur128Summary tolerates momentary lines before the summary", () => {
    const noisy = "t: 1.00    M: -20.1 LUFS    S: -21.0 LUFS    I: -22.3 LUFS\n" + EBUR128_STDERR;
    const summary = parseEbur128Summary(noisy);
    expect(summary.integratedLufs).toBe(-14.5);
  });

  test("loudnessFromReplayGain converts tag gain to LUFS", () => {
    const { lufs, peakDb } = loudnessFromReplayGain(-6.5, -0.3);
    expect(lufs).toBeCloseTo(-11.5, 5); // -18 - (-6.5)
    expect(peakDb).toBe(-0.3);
  });

  test("marks tracks with vanished files as missing", async () => {
    setupTestDb();
    const db = getDb();
    upsertTrack({
      id: "local_gone",
      source: "local",
      title: "Gone",
      artist: "A",
      album: "B",
      duration: 100,
      local_path: "/nonexistent/musaic-test/gone.flac",
    });

    const result = await runLoudnessScanJob();
    expect(result.missing).toBe(1);
    const row = db.prepare("SELECT loudness_lufs, loudness_source FROM tracks WHERE id = 'local_gone'").get() as {
      loudness_lufs: number | null;
      loudness_source: string;
    };
    expect(row.loudness_lufs).toBeNull();
    expect(row.loudness_source).toBe("missing");
  });

  test("measures a real WAV with ffmpeg when available", async () => {
    if (!ffmpegAvailable()) return; // opportunistic: skip where ffmpeg is absent
    setupTestDb();
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musaic-loudness-"));
    const file = path.join(dir, "sine.wav");
    fs.writeFileSync(file, makeSineWav());

    try {
      upsertTrack({
        id: "local_sine",
        source: "local",
        title: "Sine",
        artist: "A",
        album: "B",
        duration: 2,
        local_path: file,
      });

      const result = await runLoudnessScanJob();
      expect(result.measured + result.tagged).toBe(1);
      const row = db.prepare("SELECT loudness_lufs, loudness_peak_db, loudness_source FROM tracks WHERE id = 'local_sine'").get() as {
        loudness_lufs: number | null;
        loudness_peak_db: number | null;
        loudness_source: string;
      };
      expect(row.loudness_lufs).not.toBeNull();
      expect(row.loudness_lufs!).toBeGreaterThan(-40);
      expect(row.loudness_lufs!).toBeLessThan(0);
      expect(row.loudness_source).toBeOneOf(["ebur128", "tag"]);
      expect(row.loudness_peak_db === null || row.loudness_peak_db! <= 0).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
