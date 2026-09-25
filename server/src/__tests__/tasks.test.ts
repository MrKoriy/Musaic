import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../db/index.js";
import {
  drainTasksForTest,
  enqueueTask,
  findActiveTask,
  getTask,
  latestTask,
  onTaskUpdate,
  registerTaskHandler,
  resetTasksForTest,
  type TaskRecord,
} from "../jobs/tasks.js";
import { setupTestDb, teardownTestDb } from "./setup.js";

describe("durable task queue", () => {
  beforeEach(() => {
    setupTestDb();
    resetTasksForTest();
  });
  afterEach(() => {
    resetTasksForTest();
    teardownTestDb();
  });

  test("runs a task and stores its result", async () => {
    registerTaskHandler("echo", async (payload: { value: number }) => ({ doubled: payload.value * 2 }));
    const task = enqueueTask("echo", { value: 21 });
    expect(task.status).toBe("queued");

    await drainTasksForTest();

    const done = getTask(task.id)!;
    expect(done.status).toBe("done");
    expect(done.attempts).toBe(1);
    expect(done.result).toEqual({ doubled: 42 });
  });

  test("dedupe key returns the active task instead of enqueueing twice", async () => {
    registerTaskHandler("slow", async () => "ok");
    const first = enqueueTask("slow", {}, { dedupeKey: "k" });
    const second = enqueueTask("slow", {}, { dedupeKey: "k" });
    expect(second.id).toBe(first.id);

    await drainTasksForTest();
    // Once finished, the key is free again.
    const third = enqueueTask("slow", {}, { dedupeKey: "k" });
    expect(third.id).not.toBe(first.id);
    expect(latestTask("k")!.id).toBe(third.id);
  });

  test("failed attempts are retried later and eventually marked failed", async () => {
    let calls = 0;
    registerTaskHandler("flaky", async () => {
      calls += 1;
      throw new Error("boom");
    });
    const task = enqueueTask("flaky", {}, { maxAttempts: 2 });

    await drainTasksForTest();
    let row = getTask(task.id)!;
    expect(row.status).toBe("queued");
    expect(row.lastError).toBe("boom");
    expect(row.runAfter).toBeGreaterThan(Math.floor(Date.now() / 1000));

    getDb().prepare("UPDATE background_tasks SET run_after = 0 WHERE id = $id").run({ $id: task.id });
    await drainTasksForTest();
    row = getTask(task.id)!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  test("tasks left running by a crashed process are recovered after the lease expires", async () => {
    const task = enqueueTask("recover", { n: 1 });
    getDb().prepare(`
      UPDATE background_tasks SET status = 'running', attempts = 1, lease_until = 1 WHERE id = $id
    `).run({ $id: task.id });
    expect(findActiveTask("missing")).toBeNull();

    const seen: number[] = [];
    registerTaskHandler("recover", async (payload: { n: number }) => {
      seen.push(payload.n);
    });
    await drainTasksForTest();

    expect(seen).toEqual([1]);
    expect(getTask(task.id)!.status).toBe("done");
    expect(getTask(task.id)!.attempts).toBe(2);
  });

  test("listeners observe state transitions", async () => {
    const states: TaskRecord["status"][] = [];
    onTaskUpdate((task) => states.push(task.status));
    registerTaskHandler("observe", async () => undefined);
    enqueueTask("observe", {});
    await drainTasksForTest();
    expect(states).toEqual(["queued", "running", "done"]);
  });

  test("per-type concurrency limit is respected", async () => {
    let active = 0;
    let peak = 0;
    registerTaskHandler("limited", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    }, { concurrency: 2 });
    for (let i = 0; i < 5; i++) enqueueTask("limited", { i });
    await drainTasksForTest();
    expect(peak).toBe(2);
    const done = getDb().prepare("SELECT COUNT(*) AS n FROM background_tasks WHERE status = 'done'").get() as { n: number };
    expect(done.n).toBe(5);
  });
});
