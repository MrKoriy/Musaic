import { getDb } from "../db/index.js";
import { log } from "../logger.js";

export interface ScheduledJob {
  name: string;
  intervalHours: number;
  run: () => Promise<unknown> | unknown;
}

const jobs = new Map<string, ScheduledJob>();
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

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

export async function runJob(job: ScheduledJob, force = false): Promise<boolean> {
  const db = getDb();
  const current = nowSec();
  if (!force && !shouldRun(job, current)) return false;
  db.prepare(`
    INSERT INTO job_state (name, last_status, last_error)
    VALUES ($name, 'running', NULL)
    ON CONFLICT(name) DO UPDATE SET last_status = 'running', last_error = NULL
  `).run({ $name: job.name });
  try {
    await job.run();
    db.prepare(`
      UPDATE job_state SET last_run_at = $now, last_status = 'ok', last_error = NULL
      WHERE name = $name
    `).run({ $name: job.name, $now: nowSec() });
    log.info("jobs", `${job.name} completed`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`UPDATE job_state SET last_status = 'error', last_error = $error WHERE name = $name`)
      .run({ $name: job.name, $error: message.slice(0, 2000) });
    log.error("jobs", `${job.name} failed:`, message);
    return false;
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
