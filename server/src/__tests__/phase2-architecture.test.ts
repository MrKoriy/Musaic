import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb, getProviderConfig, setProviderConfig } from "../db/index.js";
import { runJob } from "../jobs/scheduler.js";
import { setupTestDb, teardownTestDb } from "./setup.js";
import { clearUserRecommendationCaches, getCached, setCached } from "../providers/taste-engine.js";
import { FfmpegQueue } from "../utils/ffmpeg-queue.js";
import { LRUCache, getOrSetCached, invalidateAllCaches } from "../utils/cache.js";
import { runWithRequestUser } from "../utils/request-scope.js";

describe("phase 2 server architecture", () => {
  beforeEach(() => {
    setupTestDb();
    invalidateAllCaches();
  });

  afterEach(() => {
    invalidateAllCaches();
    teardownTestDb();
  });

  it("bounds the shared cache and deduplicates in-flight work", async () => {
    const cache = new LRUCache<number>(2_000);
    for (let index = 0; index < 3_000; index++) cache.set(String(index), index);
    expect(cache.size).toBe(2_000);
    expect(cache.get("0")).toBeNull();
    expect(cache.get("2999")).toBe(2_999);

    let calls = 0;
    const factory = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "shared";
    };
    const values = await Promise.all([
      getOrSetCached("phase2-inflight", factory),
      getOrSetCached("phase2-inflight", factory),
    ]);
    expect(calls).toBe(1);
    expect(values).toEqual(["shared", "shared"]);
  });

  it("invalidates user warm and daily cache entries", () => {
    setCached("catalog-warm:phase2", true);
    setCached("daily-mix:user:user-a", { tracks: [] });
    clearUserRecommendationCaches("user-a");
    expect(getCached("catalog-warm:phase2")).toBeNull();
    expect(getCached("daily-mix:user:user-a")).toBeNull();
  });

  it("claims a job lease once and records done state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const job = {
      name: "phase2-lease",
      intervalHours: 1,
      leaseSeconds: 60,
      run: async () => gate,
    };

    const first = runJob(job);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await runJob(job, true)).toBe(false);

    const running = getDb().prepare(`
      SELECT started_at, heartbeat, instance_id FROM job_state WHERE name = $name
    `).get({ $name: job.name }) as {
      started_at: number | null;
      heartbeat: number | null;
      instance_id: string | null;
    };
    expect(running.started_at).not.toBeNull();
    expect(running.heartbeat).not.toBeNull();
    expect(running.instance_id).not.toBeNull();

    release();
    expect(await first).toBe(true);
    const completed = getDb().prepare(`
      SELECT last_status, started_at, heartbeat, instance_id FROM job_state WHERE name = $name
    `).get({ $name: job.name }) as {
      last_status: string;
      started_at: number | null;
      heartbeat: number | null;
      instance_id: string | null;
    };
    expect(completed.last_status).toBe("done");
    expect(completed.started_at).toBeNull();
    expect(completed.heartbeat).toBeNull();
    expect(completed.instance_id).toBeNull();
  });

  it("has provider, lease, cover, and ranker migration fields", () => {
    const providerColumns = getDb().prepare("PRAGMA table_info(provider_config)").all() as Array<{ name: string }>;
    expect(providerColumns.map((column) => column.name)).toEqual(["provider", "key", "value"]);

    const jobColumns = getDb().prepare("PRAGMA table_info(job_state)").all() as Array<{ name: string }>;
    expect(jobColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["started_at", "heartbeat", "instance_id"]));

    const trackColumns = getDb().prepare("PRAGMA table_info(tracks)").all() as Array<{ name: string }>;
    expect(trackColumns.map((column) => column.name)).toContain("cover_path");

    const modelColumns = getDb().prepare("PRAGMA table_info(reco_models)").all() as Array<{ name: string }>;
    expect(modelColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "baseline_auc", "precision_at_5", "precision_at_10",
    ]));
  });

  it("keeps ffmpeg work FIFO with a bounded waiting queue", async () => {
    const queue = new FfmpegQueue(2, 1);
    let active = 0;
    let maximumActive = 0;
    const work = () => queue.enqueue(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return true;
    });

    const results = await Promise.allSettled([work(), work(), work(), work()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(maximumActive).toBe(2);
  });

  it("isolates VK provider configuration between authenticated users", () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ($id, $username, 'test')")
      .run({ $id: "provider-user-a", $username: "provider-a" });
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ($id, $username, 'test')")
      .run({ $id: "provider-user-b", $username: "provider-b" });

    runWithRequestUser("provider-user-a", () => setProviderConfig("vk", "token", "token-a"));
    runWithRequestUser("provider-user-b", () => setProviderConfig("vk", "token", "token-b"));

    expect(runWithRequestUser("provider-user-a", () => getProviderConfig("vk", "token"))).toBe("token-a");
    expect(runWithRequestUser("provider-user-b", () => getProviderConfig("vk", "token"))).toBe("token-b");
  });
});
