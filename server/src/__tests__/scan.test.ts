import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "../index.js";
import { localRouter } from "../routes/local/scan.js";
import { getDb } from "../db/index.js";
import { setupTestDb, teardownTestDb } from "./setup.js";

type FetchHandler = (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
) => Response | Promise<Response>;

function installFetchMock(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => handler(input, init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function wavFile(): Buffer {
  const sampleRate = 8_000;
  const samples = Buffer.alloc(sampleRate * 2);
  const result = Buffer.alloc(44 + samples.length);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(36 + samples.length, 4);
  result.write("WAVE", 8, "ascii");
  result.write("fmt ", 12, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(samples.length, 40);
  samples.copy(result, 44);
  return result;
}

async function scanStatus() {
  const response = await localRouter.request("/status");
  return await response.json() as {
    scanning: boolean;
    scanned: number;
    total: number;
    lastScanAt: number | null;
    indexedTracks: number;
  };
}

async function waitForScan(): Promise<Awaited<ReturnType<typeof scanStatus>>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await scanStatus();
    if (!status.scanning) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("scan did not finish in time");
}

function setEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

describe("local library scan", () => {
  const tempDirs: string[] = [];

  beforeEach(setupTestDb);

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    teardownTestDb();
  });

  it("requires auth through the composed server", async () => {
    const response = await app.request(new Request("http://test.local/api/local/scan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.76",
      },
      body: JSON.stringify({ dir: "/tmp" }),
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
  });

  it("validates the directory and blocks arbitrary configured paths", async () => {
    const missingRestore = setEnv("MUSIC_DIR", undefined);
    try {
      const missing = await localRouter.request("/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({ error: "dir required (or set MUSIC_DIR env var)" });
    } finally {
      missingRestore();
    }

    const allowed = await mkdtemp(path.join(os.tmpdir(), "musaic-music-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "musaic-outside-"));
    tempDirs.push(allowed, outside);
    const musicRestore = setEnv("MUSIC_DIR", allowed);
    const arbitraryRestore = setEnv("ALLOW_SCAN_ANY_DIR", undefined);
    try {
      const blocked = await localRouter.request("/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: outside }),
      });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toEqual({
        error: "Scanning arbitrary directories is disabled. Update MUSIC_DIR or set ALLOW_SCAN_ANY_DIR=1.",
      });
    } finally {
      musicRestore();
      arbitraryRestore();
    }
  });

  it("indexes supported audio, skips hidden/non-audio files, and reports completion", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "musaic-scan-"));
    tempDirs.push(directory);
    await writeFile(path.join(directory, "Signal.wav"), wavFile());
    await writeFile(path.join(directory, "notes.txt"), "not audio");
    await writeFile(path.join(directory, ".hidden.wav"), wavFile());

    const musicRestore = setEnv("MUSIC_DIR", undefined);
    const restoreFetch = installFetchMock(() => new Response(null, { status: 404 }));
    try {
      const started = await localRouter.request("/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: directory }),
      });
      expect(started.status).toBe(200);
      const startedBody = await started.json() as {
        ok: boolean;
        message: string;
        status: { total: number };
      };
      expect(startedBody).toEqual(expect.objectContaining({ ok: true, message: "Scan started" }));
      expect(startedBody.status.total).toBe(1);

      const done = await waitForScan();
      expect(done.scanning).toBe(false);
      expect(done.total).toBe(1);
      expect(done.scanned).toBe(1);
      expect(done.indexedTracks).toBe(1);
      expect(done.lastScanAt).toBeNumber();

      const rows = getDb().prepare(
        "SELECT source, title, artist, local_path, duration FROM tracks",
      ).all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({
        source: "local",
        title: "Signal",
        artist: "Unknown Artist",
        local_path: path.join(directory, "Signal.wav"),
      }));
      expect(Number(rows[0]!.duration)).toBeGreaterThan(0);
    } finally {
      restoreFetch();
      musicRestore();
    }
  });
});
