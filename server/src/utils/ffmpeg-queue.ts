import { spawn } from "node:child_process";

export class FfmpegQueueFullError extends Error {
  constructor() {
    super("ffmpeg queue is full");
    this.name = "FfmpegQueueFullError";
  }
}

interface PendingTask<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class FfmpegQueue {
  private active = 0;
  private readonly pending: Array<PendingTask<unknown>> = [];

  constructor(
    public readonly maxConcurrent = 2,
    public readonly maxQueued = 100,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("ffmpeg maxConcurrent must be a positive integer");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("ffmpeg maxQueued must be a non-negative integer");
    }
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.pending.length >= this.maxQueued) return Promise.reject(new FfmpegQueueFullError());
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ task, resolve: resolve as (value: unknown) => void, reject });
      this.drain();
    });
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.pending.length;
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const next = this.pending.shift()!;
      this.active++;
      void Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}

const configuredConcurrent = Number(process.env.FFMPEG_MAX_CONCURRENT ?? 2);
const configuredQueued = Number(process.env.FFMPEG_MAX_QUEUE ?? 100);
export const ffmpegQueue = new FfmpegQueue(
  Number.isInteger(configuredConcurrent) && configuredConcurrent > 0 ? configuredConcurrent : 2,
  Number.isInteger(configuredQueued) && configuredQueued >= 0 ? configuredQueued : 100,
);

export interface FfmpegRunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface FfmpegResult {
  stdout: string;
  stderr: string;
}

export function runFfmpeg(args: string[], options: FfmpegRunOptions = {}): Promise<FfmpegResult> {
  return ffmpegQueue.enqueue(() => new Promise<FfmpegResult>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
      : null;
    timeout?.unref?.();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    };

    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const suffix = signal ? ` (${signal})` : ` (exit ${code ?? "unknown"})`;
        reject(new Error(`ffmpeg failed${suffix}: ${stderr.trim().slice(-500)}`));
      }
    });
  }));
}

export function ffmpegQueueStats(): { active: number; queued: number; maxConcurrent: number; maxQueued: number } {
  return {
    active: ffmpegQueue.activeCount,
    queued: ffmpegQueue.queuedCount,
    maxConcurrent: ffmpegQueue.maxConcurrent,
    maxQueued: ffmpegQueue.maxQueued,
  };
}
