import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

const enabled = process.env.RUN_QUEUE_INTEGRATION === "true";

describe.skipIf(!enabled)("BullMQ retry integration", () => {
  const queueName = `clipforge-retry-${randomUUID()}`;
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  let producer: Redis;
  let consumer: Redis;
  let queue: Queue;
  let worker: Worker | undefined;

  beforeEach(() => {
    producer = new Redis(redisUrl, { maxRetriesPerRequest: null });
    consumer = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection: producer });
  });

  afterEach(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
    await producer?.quit();
    await consumer?.quit();
    worker = undefined;
  });

  it("retries a transient failure and completes the same idempotent job", async () => {
    let runs = 0;
    worker = new Worker(queueName, async () => {
      runs += 1;
      if (runs === 1) throw new Error("temporary test failure");
      return "recovered";
    }, { connection: consumer, concurrency: 1 });

    const completed = new Promise<{ attemptsMade: number; returnvalue: unknown }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("BullMQ retry test timed out")), 30_000);
      worker!.on("completed", (job) => {
        clearTimeout(timeout);
        resolve({ attemptsMade: job.attemptsMade, returnvalue: job.returnvalue });
      });
      worker!.on("failed", (_job, error) => {
        if (runs > 1) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });

    await queue.add("retry-test", { purpose: "test retry" }, {
      jobId: "retry-once",
      attempts: 3,
      backoff: { type: "fixed", delay: 10 }
    });
    const result = await completed;

    expect(runs).toBe(2);
    expect(result).toEqual({ attemptsMade: 2, returnvalue: "recovered" });
  });

  it("retries a render job with the same clip and reframe settings", async () => {
    let runs = 0;
    worker = new Worker(queueName, async (job) => {
      runs += 1;
      expect(job.data).toMatchObject({
        type: "render",
        clipId: "clip-for-retry-test",
        reframeStrategy: "center-crop"
      });
      if (runs === 1) throw new Error("temporary ffmpeg failure");
      return "rendered";
    }, { connection: consumer, concurrency: 1 });

    const completed = new Promise<{ attemptsMade: number; returnvalue: unknown }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("BullMQ render retry test timed out")), 30_000);
      worker!.on("completed", (job) => {
        clearTimeout(timeout);
        resolve({ attemptsMade: job.attemptsMade, returnvalue: job.returnvalue });
      });
      worker!.on("failed", (_job, error) => {
        if (runs > 1) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });

    await queue.add("render", {
      type: "render",
      clipId: "clip-for-retry-test",
      reframeStrategy: "center-crop"
    }, {
      jobId: "render-retry-once",
      attempts: 3,
      backoff: { type: "fixed", delay: 10 }
    });
    const result = await completed;

    expect(runs).toBe(2);
    expect(result).toEqual({ attemptsMade: 2, returnvalue: "rendered" });
  });
});
