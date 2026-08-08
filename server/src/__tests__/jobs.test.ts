import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDb } from "../db/index.js";
import { runRetentionJob } from "../jobs/retention.js";
import { setupTestDb, teardownTestDb } from "./setup.js";

describe("background retention", () => {
  let downloadsDir: string;
  let originalDownloadsDir: string | undefined;

  beforeEach(async () => {
    setupTestDb();
    originalDownloadsDir = process.env.DOWNLOADS_DIR;
    downloadsDir = await mkdtemp(path.join(os.tmpdir(), "musaic-retention-"));
    process.env.DOWNLOADS_DIR = downloadsDir;
  });

  afterEach(async () => {
    if (originalDownloadsDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = originalDownloadsDir;
    await rm(downloadsDir, { recursive: true, force: true });
    teardownTestDb();
  });

  it("archives old events in batches and removes them from the live table", async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 366 * 86400;
    getDb().prepare("INSERT INTO listening_history (event_id, track_id, action, played_at) VALUES ('retention-event', 'track', 'play', $playedAt)")
      .run({ $playedAt: oldTimestamp });

    const result = runRetentionJob();
    expect(result.archived).toBe(1);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM listening_history").get()).toEqual({ count: 0 });
    const content = await readFile(result.archivePath!, "utf8");
    expect(content).toContain('"event_id":"retention-event"');
  });
});
