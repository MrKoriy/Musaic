import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDownloadsEvictionJob } from "../jobs/downloads-eviction.js";

const HOUR = 3600_000;
const DAY = 86_400_000;

describe("downloads eviction job", () => {
  let dir: string;
  let previousDownloadsDir: string | undefined;
  let previousTtl: string | undefined;
  let previousCap: string | undefined;

  function touch(file: string, atimeMs: number, mtimeMs: number, size = 1024) {
    fs.writeFileSync(file, Buffer.alloc(size));
    fs.utimesSync(file, new Date(atimeMs), new Date(mtimeMs));
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "musaic-evict-"));
    previousDownloadsDir = process.env.DOWNLOADS_DIR;
    previousTtl = process.env.DOWNLOADS_TTL_DAYS;
    previousCap = process.env.DOWNLOADS_MAX_BYTES;
    process.env.DOWNLOADS_DIR = dir;
    process.env.DOWNLOADS_TTL_DAYS = "60";
    delete process.env.DOWNLOADS_MAX_BYTES;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previousDownloadsDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = previousDownloadsDir;
    if (previousTtl === undefined) delete process.env.DOWNLOADS_TTL_DAYS;
    else process.env.DOWNLOADS_TTL_DAYS = previousTtl;
    if (previousCap === undefined) delete process.env.DOWNLOADS_MAX_BYTES;
    else process.env.DOWNLOADS_MAX_BYTES = previousCap;
  });

  it("removes only files untouched for longer than the TTL", () => {
    const now = Date.now();
    touch(path.join(dir, "stale.mp3"), now - 70 * DAY, now - 70 * DAY, 100);
    touch(path.join(dir, "fresh.mp3"), now - 10 * DAY, now - 10 * DAY, 200);

    const result = runDownloadsEvictionJob();

    expect(result.ttlDeleted).toBe(1);
    expect(result.freedBytes).toBe(100);
    expect(fs.existsSync(path.join(dir, "stale.mp3"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "fresh.mp3"))).toBe(true);
  });

  it("never touches the archive subtree", () => {
    const now = Date.now();
    fs.mkdirSync(path.join(dir, "archive"), { recursive: true });
    touch(path.join(dir, "archive", "history-2026.jsonl"), now - 400 * DAY, now - 400 * DAY, 500);
    touch(path.join(dir, "archive", "nested"), now - 400 * DAY, now - 400 * DAY, 500);

    const result = runDownloadsEvictionJob();

    expect(result.ttlDeleted).toBe(0);
    expect(fs.existsSync(path.join(dir, "archive", "history-2026.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "archive", "nested"))).toBe(true);
  });

  it("enforces the size cap deleting the least recently used first, sparing recent files", () => {
    const now = Date.now();
    process.env.DOWNLOADS_MAX_BYTES = "2000";
    touch(path.join(dir, "old-a.mp3"), now - 30 * DAY, now - 30 * DAY, 1024);
    touch(path.join(dir, "old-b.mp3"), now - 20 * DAY, now - 20 * DAY, 1024);
    touch(path.join(dir, "recent.mp3"), now - 2 * DAY, now - 2 * DAY, 1024);

    const result = runDownloadsEvictionJob();

    // old-a (LRU) and old-b are deleted to fit 2000 bytes; recent stays.
    expect(result.capDeleted).toBe(2);
    expect(fs.existsSync(path.join(dir, "old-a.mp3"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "old-b.mp3"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "recent.mp3"))).toBe(true);
    expect(result.totalBytes).toBe(1024);
  });

  it("evicts compressed transcodes but keeps files inside the hour-long grace window", () => {
    const now = Date.now();
    process.env.DOWNLOADS_MAX_BYTES = "1"; // force cap pass
    fs.mkdirSync(path.join(dir, "compressed"), { recursive: true });
    touch(path.join(dir, "compressed", "abc_128.m4a"), now - 90 * DAY, now - 90 * DAY, 4096);
    touch(path.join(dir, "playing-now.mp3"), now - 10 * 60_000, now - 10 * 60_000, 8192);

    const result = runDownloadsEvictionJob();

    expect(result.ttlDeleted).toBe(1); // compressed file is beyond TTL
    expect(fs.existsSync(path.join(dir, "compressed", "abc_128.m4a"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "playing-now.mp3"))).toBe(true);
  });

  it("cleans up leftover tmp files older than a day but keeps fresh ones", () => {
    const now = Date.now();
    touch(path.join(dir, "dead.tmp"), now - 2 * DAY, now - 2 * DAY, 64);
    touch(path.join(dir, "inflight.tmp"), now - 5 * 60_000, now - 5 * 60_000, 64);

    const result = runDownloadsEvictionJob();

    expect(result.tmpDeleted).toBe(1);
    expect(fs.existsSync(path.join(dir, "dead.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "inflight.tmp"))).toBe(true);
  });
});
