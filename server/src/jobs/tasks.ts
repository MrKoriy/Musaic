/**
 * Durable background task queue backed by the `background_tasks` table.
 *
 * Work that must survive a restart (lyrics generation, playlist imports,
 * scrobble delivery…) is enqueued here instead of living in an in-memory Map.
 * A worker claims due tasks with a lease; a crashed process leaves the lease
 * to expire and the task is picked up again on the next start.
 *
 *   registerTaskHandler("lyrics.generate", async (payload, ctx) => { … });
 *   const task = enqueueTask("lyrics.generate", { trackId }, { dedupeKey: `lyrics:${trackId}` });
 */
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { log } from "../logger.js";

export type TaskStatus = "queued" | "running" | "done" | "failed";

export interface TaskRecord {
  id: string;
  type: string;
  dedupeKey: string | null;
  payload: unknown;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  lastError: string | null;
  result: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface TaskContext {
  taskId: string;
  /** 1-based attempt number of the current run. */
  attempt: number;
  /** Aborted when the worker is stopping; long handlers should honour it. */
  signal: AbortSignal;
}

// Payload is JSON decoded from storage; each handler narrows it to its own shape.
export type TaskHandler = (payload: any, ctx: TaskContext) => Promise<unknown> | unknown;

export interface TaskHandlerOptions {
  /** Parallel runs of this task type in one process. Default 1. */
  concurrency?: number;
  /** Lease length; renewed while the handler runs. Default 120 s. */
  leaseSeconds?: number;
}

export interface EnqueueOptions {
  /** At most one queued/running task per key; enqueueing again returns it. */
  dedupeKey?: string;
  delaySeconds?: number;
  maxAttempts?: number;
}

interface RegisteredHandler {
  handler: TaskHandler;
  concurrency: number;
  leaseSeconds: number;
  running: number;
}

interface TaskRow {
  id: string;
  type: string;
  dedupe_key: string | null;
  payload: string;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  run_after: number;
  last_error: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

const handlers = new Map<string, RegisteredHandler>();
const listeners = new Set<(task: TaskRecord) => void>();
const inflight = new Set<Promise<void>>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let abortController = new AbortController();
let pumping = false;
let pumpAgain = false;
let lastCleanupAt = 0;

const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_SECONDS = 30 * 60;
const FINISHED_RETENTION_SECONDS = 7 * 24 * 3600;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function parseJson(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    type: row.type,
    dedupeKey: row.dedupe_key,
    payload: parseJson(row.payload),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAfter: Number(row.run_after),
    lastError: row.last_error,
    result: parseJson(row.result),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function emit(task: TaskRecord | null): void {
  if (!task) return;
  for (const listener of listeners) {
    try {
      listener(task);
    } catch (error) {
      log.warn("tasks", "task listener failed:", error instanceof Error ? error.message : String(error));
    }
  }
}

export function registerTaskHandler(type: string, handler: TaskHandler, options: TaskHandlerOptions = {}): void {
  handlers.set(type, {
    handler,
    concurrency: Math.max(1, Math.floor(options.concurrency ?? 1)),
    leaseSeconds: Math.max(5, Math.floor(options.leaseSeconds ?? 120)),
    running: handlers.get(type)?.running ?? 0,
  });
}

export function getTask(id: string): TaskRecord | null {
  const row = getDb().prepare("SELECT * FROM background_tasks WHERE id = $id").get({ $id: id }) as TaskRow | null;
  return row ? toRecord(row) : null;
}

/** Queued or running task for a dedupe key, if any. */
export function findActiveTask(dedupeKey: string): TaskRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM background_tasks
    WHERE dedupe_key = $key AND status IN ('queued', 'running')
    LIMIT 1
  `).get({ $key: dedupeKey }) as TaskRow | null;
  return row ? toRecord(row) : null;
}

/** Most recent task for a dedupe key in any state. */
export function latestTask(dedupeKey: string): TaskRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM background_tasks
    WHERE dedupe_key = $key
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get({ $key: dedupeKey }) as TaskRow | null;
  return row ? toRecord(row) : null;
}

export function enqueueTask(type: string, payload: unknown, options: EnqueueOptions = {}): TaskRecord {
  const db = getDb();
  const dedupeKey = options.dedupeKey ?? null;
  const now = nowSec();
  const id = crypto.randomUUID();
  const insert = db.transaction(() => {
    if (dedupeKey) {
      const existing = findActiveTask(dedupeKey);
      if (existing) return existing;
    }
    db.prepare(`
      INSERT INTO background_tasks (id, type, dedupe_key, payload, status, max_attempts, run_after, created_at, updated_at)
      VALUES ($id, $type, $key, $payload, 'queued', $max, $runAfter, $now, $now)
    `).run({
      $id: id,
      $type: type,
      $key: dedupeKey,
      $payload: JSON.stringify(payload ?? {}),
      $max: Math.max(1, Math.floor(options.maxAttempts ?? 3)),
      $runAfter: now + Math.max(0, Math.floor(options.delaySeconds ?? 0)),
      $now: now,
    });
    return getTask(id)!;
  });
  const task = insert();
  if (task.id === id) {
    emit(task);
    kick();
  }
  return task;
}

/** Subscribe to every task state change in this process. */
export function onTaskUpdate(listener: (task: TaskRecord) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Return tasks whose lease expired (crashed worker) to the queue. */
function recoverExpiredLeases(now: number): void {
  const rows = getDb().prepare(`
    UPDATE background_tasks
    SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
        last_error = COALESCE(last_error, 'lease expired'),
        lease_until = NULL,
        run_after = $now,
        updated_at = $now
    WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < $now
    RETURNING *
  `).all({ $now: now }) as TaskRow[];
  for (const row of rows) emit(toRecord(row));
}

function cleanupFinished(now: number): void {
  if (now - lastCleanupAt < 3600) return;
  lastCleanupAt = now;
  getDb().prepare(`
    DELETE FROM background_tasks
    WHERE status IN ('done', 'failed') AND updated_at < $before
  `).run({ $before: now - FINISHED_RETENTION_SECONDS });
}

function claim(type: string, entry: RegisteredHandler, now: number): TaskRow | null {
  return getDb().prepare(`
    UPDATE background_tasks
    SET status = 'running', attempts = attempts + 1, lease_until = $lease, updated_at = $now
    WHERE id = (
      SELECT id FROM background_tasks
      WHERE status = 'queued' AND type = $type AND run_after <= $now
      ORDER BY run_after, created_at, rowid
      LIMIT 1
    )
    RETURNING *
  `).get({ $type: type, $now: now, $lease: now + entry.leaseSeconds }) as TaskRow | null;
}

function finish(id: string, status: "done" | "failed" | "queued", fields: { result?: unknown; error?: string; retryAt?: number }): void {
  const now = nowSec();
  const row = getDb().prepare(`
    UPDATE background_tasks
    SET status = $status,
        result = $result,
        last_error = $error,
        lease_until = NULL,
        run_after = COALESCE($retryAt, run_after),
        updated_at = $now
    WHERE id = $id
    RETURNING *
  `).get({
    $id: id,
    $status: status,
    $result: fields.result === undefined ? null : JSON.stringify(fields.result),
    $error: fields.error?.slice(0, 2000) ?? null,
    $retryAt: fields.retryAt ?? null,
    $now: now,
  }) as TaskRow | null;
  if (row) emit(toRecord(row));
}

async function execute(row: TaskRow, entry: RegisteredHandler): Promise<void> {
  const task = toRecord(row);
  emit(task);
  const renewEveryMs = Math.max(1_000, Math.floor((entry.leaseSeconds * 1000) / 3));
  const renew = setInterval(() => {
    try {
      getDb().prepare("UPDATE background_tasks SET lease_until = $lease WHERE id = $id AND status = 'running'")
        .run({ $id: task.id, $lease: nowSec() + entry.leaseSeconds });
    } catch (error) {
      log.warn("tasks", `lease renewal failed for ${task.type}:`, error instanceof Error ? error.message : String(error));
    }
  }, renewEveryMs);
  renew.unref?.();

  try {
    const result = await entry.handler(task.payload, {
      taskId: task.id,
      attempt: task.attempts,
      signal: abortController.signal,
    });
    finish(task.id, "done", { result: result ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (abortController.signal.aborted) {
      // Shutting down: give the attempt back so the next start retries it.
      getDb().prepare(`
        UPDATE background_tasks
        SET status = 'queued', attempts = MAX(0, attempts - 1), lease_until = NULL, updated_at = $now
        WHERE id = $id
      `).run({ $id: task.id, $now: nowSec() });
      return;
    }
    if (task.attempts < task.maxAttempts) {
      const delay = Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** Math.max(0, task.attempts - 1));
      log.warn("tasks", `${task.type} attempt ${task.attempts}/${task.maxAttempts} failed, retrying in ${delay}s:`, message);
      finish(task.id, "queued", { error: message, retryAt: nowSec() + delay });
    } else {
      log.error("tasks", `${task.type} failed permanently:`, message);
      finish(task.id, "failed", { error: message });
    }
  } finally {
    clearInterval(renew);
  }
}

/** Claim and start every due task that fits the per-type concurrency. */
function pump(): void {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      const now = nowSec();
      recoverExpiredLeases(now);
      cleanupFinished(now);
      for (const [type, entry] of handlers) {
        while (entry.running < entry.concurrency && !abortController.signal.aborted) {
          const row = claim(type, entry, now);
          if (!row) break;
          entry.running += 1;
          const run = execute(row, entry).finally(() => {
            entry.running -= 1;
            inflight.delete(run);
            if (pollTimer) kick();
          });
          inflight.add(run);
        }
      }
    } while (pumpAgain);
  } catch (error) {
    log.error("tasks", "task pump failed:", error instanceof Error ? error.message : String(error));
  } finally {
    pumping = false;
  }
}

function kick(): void {
  if (!pollTimer) return;
  queueMicrotask(pump);
}

export function startTaskWorker(pollMs = 2_000): void {
  if (pollTimer) return;
  abortController = new AbortController();
  pollTimer = setInterval(pump, Math.max(100, pollMs));
  pollTimer.unref?.();
  kick();
  log.info("tasks", `task worker started (${handlers.size} handler(s))`);
}

/** Stop claiming work, abort running handlers and wait up to `graceMs` for them. */
export async function stopTaskWorker(graceMs = 5_000): Promise<void> {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  abortController.abort();
  if (inflight.size === 0) return;
  await Promise.race([
    Promise.allSettled([...inflight]),
    new Promise((resolve) => setTimeout(resolve, graceMs).unref?.()),
  ]);
}

/**
 * Test helper: run due tasks until the queue is idle. Retries scheduled in the
 * future are left alone so tests can assert on them.
 */
export async function drainTasksForTest(maxRounds = 50): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const now = nowSec();
    recoverExpiredLeases(now);
    let started = 0;
    for (const [type, entry] of handlers) {
      while (entry.running < entry.concurrency) {
        const row = claim(type, entry, now);
        if (!row) break;
        started += 1;
        entry.running += 1;
        const run = execute(row, entry).finally(() => {
          entry.running -= 1;
          inflight.delete(run);
        });
        inflight.add(run);
      }
    }
    if (started === 0 && inflight.size === 0) return;
    await Promise.allSettled([...inflight]);
  }
}

export function resetTasksForTest(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  handlers.clear();
  listeners.clear();
  inflight.clear();
  abortController = new AbortController();
  pumping = false;
  pumpAgain = false;
  lastCleanupAt = 0;
}
