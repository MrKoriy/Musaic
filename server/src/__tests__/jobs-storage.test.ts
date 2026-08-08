import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPlaylist,
  getCoverData,
  getDb,
  getPlaylistCoverData,
  setCoverData,
  setPlaylistCoverData,
} from "../db/index.js";
import { runCoverMigrationJob } from "../jobs/cover-migration.js";
import {
  registerJob,
  registeredJobs,
  resetSchedulerForTest,
  runJob,
  runRegisteredJobs,
  startScheduler,
  stopScheduler,
  type ScheduledJob,
} from "../jobs/scheduler.js";
import { runRetentionJob } from "../jobs/retention.js";
import { coverRelativePath, readCoverFile } from "../utils/cover-storage.js";
import { seedTrack, setupTestDb, teardownTestDb } from "./setup.js";

describe("scheduled job leases", () => {
  beforeEach(() => {
    setupTestDb();
    resetSchedulerForTest();
  });

  afterEach(() => {
    stopScheduler();
    resetSchedulerForTest();
    teardownTestDb();
  });

  it("validates registrations and records a completed job only once while due", async () => {
    expect(() => registerJob({ name: "", intervalHours: 1, run: () => undefined })).toThrow("Invalid scheduled job");
    expect(() => registerJob({ name: "invalid", intervalHours: 0, run: () => undefined })).toThrow("Invalid scheduled job");

    let calls = 0;
    const job: ScheduledJob = {
      name: "test-complete",
      intervalHours: 24,
      run: () => { calls++; },
    };
    registerJob(job);
    expect(registeredJobs()).toEqual(["test-complete"]);

    await expect(runJob(job)).resolves.toBe(true);
    await expect(runJob(job)).resolves.toBe(false);
    expect(calls).toBe(1);
    expect(getDb().prepare(
      "SELECT last_status, last_error, started_at, heartbeat, instance_id FROM job_state WHERE name = $name",
    ).get({ $name: job.name })).toEqual({
      last_status: "done",
      last_error: null,
      started_at: null,
      heartbeat: null,
      instance_id: null,
    });
  });

  it("prevents overlapping runs and recovers a stale lease", async () => {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const job: ScheduledJob = {
      name: "test-overlap",
      intervalHours: 1,
      leaseSeconds: 10,
      run: async () => {
        markStarted();
        await gate;
      },
    };

    const first = runJob(job, true);
    await started;
    await expect(runJob(job, true)).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);

    const now = Math.floor(Date.now() / 1000);
    getDb().prepare(`
      INSERT INTO job_state (name, last_run_at, last_status, started_at, heartbeat, instance_id)
      VALUES ($name, $lastRun, 'running', $started, $heartbeat, 'dead-instance')
    `).run({
      $name: "test-stale",
      $lastRun: now - 7200,
      $started: now - 100,
      $heartbeat: now - 100,
    });
    let recovered = 0;
    const staleJob: ScheduledJob = {
      name: "test-stale",
      intervalHours: 1,
      leaseSeconds: 10,
      run: () => { recovered++; },
    };

    await expect(runJob(staleJob)).resolves.toBe(true);
    expect(recovered).toBe(1);
    expect(getDb().prepare("SELECT last_status, instance_id FROM job_state WHERE name = $name")
      .get({ $name: staleJob.name })).toEqual({ last_status: "done", instance_id: null });
  });

  it("marks failures, runs registered jobs, and remains disabled in tests", async () => {
    const failed: ScheduledJob = {
      name: "test-failed",
      intervalHours: 1,
      run: () => { throw new Error("expected failure"); },
    };
    await expect(runJob(failed, true)).resolves.toBe(false);
    expect(getDb().prepare("SELECT last_status, last_error FROM job_state WHERE name = $name")
      .get({ $name: failed.name })).toEqual({ last_status: "failed", last_error: "expected failure" });

    const calls: string[] = [];
    registerJob({ name: "first", intervalHours: 1, run: () => { calls.push("first"); } });
    registerJob({ name: "second", intervalHours: 1, run: () => { calls.push("second"); } });
    await runRegisteredJobs(true);
    expect(calls).toEqual(["first", "second"]);

    startScheduler();
    stopScheduler();
  });
});

describe("listening-history retention", () => {
  const tempDirs: string[] = [];
  let previousDownloadsDir: string | undefined;

  beforeEach(async () => {
    setupTestDb();
    previousDownloadsDir = process.env.DOWNLOADS_DIR;
    const directory = await mkdtemp(path.join(os.tmpdir(), "musaic-retention-"));
    tempDirs.push(directory);
    process.env.DOWNLOADS_DIR = directory;
  });

  afterEach(async () => {
    if (previousDownloadsDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = previousDownloadsDir;
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    teardownTestDb();
  });

  it("archives old events as JSONL, removes them, and is idempotent", async () => {
    const oldTrack = seedTrack({ id: "retention-old" });
    const recentTrack = seedTrack({ id: "retention-recent" });
    const now = Math.floor(Date.now() / 1000);
    getDb().prepare(`
      INSERT INTO listening_history (track_id, action, played_at, user_id)
      VALUES ($trackId, 'play', $playedAt, NULL)
    `).run({ $trackId: oldTrack, $playedAt: now - 3 * 86400 });
    getDb().prepare(`
      INSERT INTO listening_history (track_id, action, played_at, user_id)
      VALUES ($trackId, 'complete', $playedAt, NULL)
    `).run({ $trackId: oldTrack, $playedAt: now - 2 * 86400 });
    getDb().prepare(`
      INSERT INTO listening_history (track_id, action, played_at, user_id)
      VALUES ($trackId, 'play', $playedAt, NULL)
    `).run({ $trackId: recentTrack, $playedAt: now });

    const result = runRetentionJob(1);
    expect(result.archived).toBe(2);
    expect(result.archivePath).toBeString();
    const archive = await readFile(result.archivePath!, "utf8");
    const rows = archive.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.track_id)).toEqual([oldTrack, oldTrack]);
    expect(getDb().prepare("SELECT track_id, action FROM listening_history ORDER BY id").all()).toEqual([
      { track_id: recentTrack, action: "play" },
    ]);

    expect(runRetentionJob(1)).toEqual({ archived: 0, archivePath: null });
  });

  it("does not create an archive when every event is within the retention window", () => {
    const trackId = seedTrack({ id: "retention-current" });
    getDb().prepare(
      "INSERT INTO listening_history (track_id, action, played_at) VALUES ($trackId, 'play', unixepoch())",
    ).run({ $trackId: trackId });

    expect(runRetentionJob(365)).toEqual({ archived: 0, archivePath: null });
  });
});

describe("cover file migration", () => {
  const tempDirs: string[] = [];
  let previousCoversDir: string | undefined;

  beforeEach(async () => {
    setupTestDb();
    previousCoversDir = process.env.COVERS_DIR;
    const directory = await mkdtemp(path.join(os.tmpdir(), "musaic-covers-"));
    tempDirs.push(directory);
    process.env.COVERS_DIR = directory;
  });

  afterEach(async () => {
    if (previousCoversDir === undefined) delete process.env.COVERS_DIR;
    else process.env.COVERS_DIR = previousCoversDir;
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    teardownTestDb();
  });

  it("moves track and playlist BLOBs to disk while keeping reads compatible", () => {
    const trackId = seedTrack({ id: "cover-track" });
    createPlaylist("cover-playlist", "Cover Playlist");
    const trackData = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const playlistData = Buffer.from("playlist-cover");
    setCoverData(trackId, trackData, "image/jpeg");
    setPlaylistCoverData("cover-playlist", playlistData, "image/png");

    expect(runCoverMigrationJob(0)).toEqual({ tracks: 1, playlists: 1 });
    const trackRow = getDb().prepare("SELECT cover_path FROM tracks WHERE id = $id").get({ $id: trackId }) as { cover_path: string };
    const playlistRow = getDb().prepare("SELECT file_path FROM playlist_cover_data WHERE playlist_id = $id")
      .get({ $id: "cover-playlist" }) as { file_path: string };
    expect(trackRow.cover_path).toBe(coverRelativePath(trackId, "image/jpeg"));
    expect(playlistRow.file_path).toBe(coverRelativePath("cover-playlist", "image/png", true));
    expect(fs.existsSync(path.join(process.env.COVERS_DIR!, trackRow.cover_path))).toBe(true);
    expect(fs.existsSync(path.join(process.env.COVERS_DIR!, playlistRow.file_path))).toBe(true);
    expect(getCoverData(trackId)).toEqual({ data: trackData, mimeType: "image/jpeg" });
    expect(getPlaylistCoverData("cover-playlist")).toEqual({ data: playlistData, mimeType: "image/png" });
    expect(runCoverMigrationJob()).toEqual({ tracks: 0, playlists: 0 });
  });

  it("sanitizes cover names and rejects paths outside the covers root", () => {
    expect(coverRelativePath("../album/cover", "image/webp")).toBe("_album_cover.webp");
    expect(readCoverFile("../outside.jpg")).toBeNull();
  });
});
