import { getDb } from "../db/index.js";
import { log } from "../logger.js";
import crypto from "crypto";

export interface ScheduledJob {
  name: string;
  intervalHours: number;
  /** Optional test/operator override; default is two scheduling intervals. */
  leaseSeconds?: number;
  run: () => Promise<unknown> | unknown;
}

const jobs = new Map<string, ScheduledJob>();
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;

export function registerJob(job: ScheduledJob): void {
  if (!job.name || !Number.isFinite(job.intervalHours) || job.intervalHours <= 0) {
    throw new Error(`Invalid scheduled job: ${job.name}`);
  }
  jobs.set(job.name, job);
}

export function registeredJobs(): string[] {
  return [...jobs.keys()];
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function shouldRun(job: ScheduledJob, current: number): boolean {
  const row = getDb().prepare("SELECT last_run_at FROM job_state WHERE name = $name")
    .get({ $name: job.name }) as { last_run_at: number | null } | null;
  return !row?.last_run_at || current - Number(row.last_run_at) >= job.intervalHours * 3600;
}

function leaseTimeoutSeconds(job: ScheduledJob): number {
  return Math.max(1, Math.floor(job.leaseSeconds ?? job.intervalHours * 2 * 3600));
}

/** Atomically claim a due job, including stale-lease recovery. */
function acquireLease(job: ScheduledJob, current: number, force: boolean): boolean {
  const db = getDb();
  const staleBefore = current - leaseTimeoutSeconds(job);
  const result = db.prepare(`
    INSERT INTO job_state (
      name, last_status, last_error, started_at, heartbeat, instance_id
    ) VALUES ($name, 'running', NULL, $now, $now, $instance)
    ON CONFLICT(name) DO UPDATE SET
      last_status = 'running',
      last_error = NULL,
      started_at = $now,
      heartbeat = $now,
      instance_id = $instance
    WHERE (job_state.heartbeat IS NULL OR job_state.heartbeat < $staleBefore)
      AND (
        $force = 1 OR job_state.last_run_at IS NULL OR
        job_state.last_run_at <= $dueBefore
      )
  `).run({
    $name: job.name,
    $now: current,
    $instance: INSTANCE_ID,
    $staleBefore: staleBefore,
    $dueBefore: current - Math.floor(job.intervalHours * 3600),
    $force: force ? 1 : 0,
  }) as { changes?: number };
  return Number(result.changes ?? 0) > 0;
}

function updateHeartbeat(jobName: string, now: number): void {
  getDb().prepare(`
    UPDATE job_state SET heartbeat = $now
    WHERE name = $name AND instance_id = $instance
  `).run({ $name: jobName, $now: now, $instance: INSTANCE_ID });
}

export async function runJob(job: ScheduledJob, force = false): Promise<boolean> {
  const db = getDb();
  const current = nowSec();
  if (!force && !shouldRun(job, current)) return false;
  if (!acquireLease(job, current, force)) {
    log.info("jobs", `${job.name} skipped because another instance holds its lease`);
    return false;
  }

  const heartbeatEveryMs = Math.max(1_000, Math.min(30_000, leaseTimeoutSeconds(job) * 500));
  const heartbeatTimer = setInterval(() => {
    try {
      updateHeartbeat(job.name, nowSec());
    } catch (error) {
      log.warn("jobs", `${job.name} heartbeat failed:`, error instanceof Error ? error.message : String(error));
    }
  }, heartbeatEveryMs);
  heartbeatTimer.unref?.();

  try {
    await job.run();
    db.prepare(`
      UPDATE job_state
      SET last_run_at = $now, last_status = 'done', last_error = NULL,
          started_at = NULL, heartbeat = NULL, instance_id = NULL
      WHERE name = $name AND instance_id = $instance
    `).run({ $name: job.name, $now: nowSec(), $instance: INSTANCE_ID });
    log.info("jobs", `${job.name} completed`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`
      UPDATE job_state
      SET last_status = 'failed', last_error = $error,
          started_at = NULL, heartbeat = NULL, instance_id = NULL
      WHERE name = $name AND instance_id = $instance
    `).run({ $name: job.name, $error: message.slice(0, 2000), $instance: INSTANCE_ID });
    log.error("jobs", `${job.name} failed:`, message);
    return false;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function runRegisteredJobs(force = false): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const job of jobs.values()) await runJob(job, force);
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  if (timer || process.env.JOBS_ENABLED === "0" || process.env.NODE_ENV === "test") return;
  void runRegisteredJobs();
  timer = setInterval(() => { void runRegisteredJobs(); }, 60 * 60 * 1000);
  timer.unref?.();
  log.info("jobs", `scheduler started (${jobs.size} job(s))`);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function resetSchedulerForTest(): void {
  stopScheduler();
  jobs.clear();
  running = false;
}
