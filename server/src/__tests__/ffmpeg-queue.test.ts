import { describe, expect, it } from "bun:test";
import { FfmpegQueue, FfmpegQueueFullError } from "../utils/ffmpeg-queue.js";

describe("ffmpeg work queue", () => {
  it("runs FIFO work, bounds waiting tasks, and releases active slots", async () => {
    const queue = new FfmpegQueue(1, 1);
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.enqueue(async () => {
      markStarted();
      await firstGate;
      return "first";
    });
    await firstStarted;

    const second = queue.enqueue(async () => "second");
    const rejected = queue.enqueue(async () => "third");
    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(1);
    await expect(rejected).rejects.toBeInstanceOf(FfmpegQueueFullError);

    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(queue.activeCount).toBe(0);
    expect(queue.queuedCount).toBe(0);
  });

  it("continues draining after a task rejects", async () => {
    const queue = new FfmpegQueue(1, 2);
    const failed = queue.enqueue(async () => {
      throw new Error("ffmpeg failed");
    });
    const next = queue.enqueue(async () => "next");

    await expect(failed).rejects.toThrow("ffmpeg failed");
    await expect(next).resolves.toBe("next");
    expect(queue.activeCount).toBe(0);
    expect(queue.queuedCount).toBe(0);
  });
});
