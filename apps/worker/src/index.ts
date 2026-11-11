import { Queue, Worker, type Job as BullJob } from "bullmq";
import { access } from "node:fs/promises";
import { W_OK } from "node:constants";
import { Redis } from "ioredis";
import mongoose from "mongoose";
import { config } from "./config.js";
import { WorkerJobModel, WorkerUserModel, WorkerVideoModel } from "./models.js";
import { analyzeVideo, cleanupStaleWorkerDirectories, recomputeTopics, recordJobFailure } from "./pipeline/analyze-video.js";
import { importVideo } from "./pipeline/import-video.js";
import { findVideoClips } from "./pipeline/find-clips.js";
import { renderClip } from "./pipeline/render-clip.js";
import { generateClipMetadata } from "./pipeline/generate-clip-metadata.js";
import type { CaptionStyle } from "@clipforge/shared/caption-config";

const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue("video-analysis", { connection });
await mongoose.connect(config.mongoUri);
console.log(JSON.stringify({ level: "info", event: "worker.mongo.connected" }));

async function checkEmbeddingCacheWritable() {
  const cacheDir = process.env.FASTEMBED_CACHE_DIR ?? "/models/fastembed";
  try {
    await access(cacheDir, W_OK);
  } catch {
    console.warn(JSON.stringify({
      level: "warn",
      event: "embedding.cache.not_writable",
      cacheDir,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      message: "Embedding cache folder is not writable: run `docker compose run --rm --user 0:0 worker sh -c 'chown -R \"$LOCAL_UID:$LOCAL_GID\" /models/fastembed'`"
    }));
    return;
  }
  console.log(JSON.stringify({ level: "info", event: "embedding.cache.writable", cacheDir }));
}

await checkEmbeddingCacheWritable();

async function checkTrendConfiguration() {
  if (!config.youtubeApiKey) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "youtube.trends.not_configured",
      message: "Trend data is offline: add YOUTUBE_API_KEY to .env, then rebuild/restart the worker"
    }));
    return;
  }
  console.log(JSON.stringify({
    level: "info",
    event: "youtube.trends.configured",
    regionCode: config.youtubeRegionCode,
    relevanceLanguage: config.youtubeRelevanceLanguage
  }));
}

await checkTrendConfiguration();

async function markOrphanedActiveJobsAsFailed() {
  const activeJobs = await WorkerJobModel.find({ status: { $in: ["queued", "processing"] } }).lean();
  for (const job of activeJobs) {
    const bullJob = await queue.getJob(job.queueJobId);
    const state = bullJob ? await bullJob.getState() : "missing";
    const shouldFail = !bullJob || !["waiting", "active", "delayed", "prioritized", "waiting-children"].includes(state);
    if (!shouldFail) continue;
    await WorkerJobModel.updateOne({ _id: job._id }, {
      $set: {
        status: "failed",
        progress: { stage: "failed", message: "Orphaned active job; worker restarted", percent: 0 },
        failedReason: "Orphaned active job; worker restarted",
        completedAt: new Date()
      }
    });
    if (job.type !== "render" && job.type !== "metadata") {
      await WorkerUserModel.updateOne({ _id: job.userId, activeAnalysisJobs: { $gt: 0 } }, { $inc: { activeAnalysisJobs: -1 } });
    }
  }
}

await markOrphanedActiveJobsAsFailed();

const queueWorker = new Worker(
  "video-analysis",
  async (bullJob: BullJob<{
    type: "analysis" | "url-import" | "find-clips" | "render" | "metadata" | "recompute-topics";
    userId: string;
    videoId: string;
    databaseJobId: string;
    modelSpeed?: "fast" | "balanced";
    sourceUrl?: string;
    clipId?: string;
    reframeStrategy?: "blur-fit" | "center-crop";
    captionStyle?: CaptionStyle;
    cleanupCaptionFillers?: boolean;
    captionPreview?: boolean;
    previewId?: string;
    options?: { language: "same" | "english"; tone: "curious" | "direct" | "informative"; includeOriginalCredit: boolean; useGemini: boolean };
    useGemini?: boolean;
  }>) => {
    const commonInput = {
      userId: bullJob.data.userId,
      videoId: bullJob.data.videoId,
      databaseJobId: bullJob.data.databaseJobId,
      queueJobId: bullJob.id ?? "unknown",
      attemptNumber: bullJob.attemptsMade + 1
    };

    if (bullJob.data.type === "url-import") {
      const input = { ...commonInput, sourceUrl: bullJob.data.sourceUrl ?? "" };
      console.log(JSON.stringify({
        level: "info",
        event: "url_import.started",
        jobId: input.queueJobId,
        videoId: input.videoId,
        attempt: input.attemptNumber
      }));
      try {
        await importVideo(input, (progress) => bullJob.updateProgress(progress));
      } catch (error) {
        await recordJobFailure(input, error);
        throw error;
      }
      return;
    }

    if (bullJob.data.type === "find-clips") {
      console.log(JSON.stringify({
        level: "info",
        event: "clips.find.started",
        jobId: commonInput.queueJobId,
        videoId: commonInput.videoId,
        attempt: commonInput.attemptNumber
      }));
      try {
        await findVideoClips({ ...commonInput, useGemini: bullJob.data.useGemini ?? false }, (progress) => bullJob.updateProgress(progress));
      } catch (error) {
        await recordJobFailure(commonInput, error);
        throw error;
      }
      return;
    }

    if (bullJob.data.type === "render") {
      if (!bullJob.data.clipId) throw new Error("The render job has no clip ID");
      const input = {
        ...commonInput,
        clipId: bullJob.data.clipId,
        reframeStrategy: bullJob.data.reframeStrategy === "center-crop" ? "center-crop" as const : "blur-fit" as const,
        previewOnly: bullJob.data.captionPreview ?? false,
        ...(bullJob.data.captionStyle ? { captionStyle: bullJob.data.captionStyle } : {}),
        ...(bullJob.data.cleanupCaptionFillers !== undefined
          ? { cleanupCaptionFillers: bullJob.data.cleanupCaptionFillers }
          : {}),
        ...(bullJob.data.previewId ? { previewId: bullJob.data.previewId } : {})
      };
      console.log(JSON.stringify({
        level: "info",
        event: "clip.render.started",
        jobId: commonInput.queueJobId,
        clipId: input.clipId,
        videoId: input.videoId,
        attempt: input.attemptNumber
      }));
      try {
        await renderClip(input, (progress) => bullJob.updateProgress(progress));
      } catch (error) {
        await recordJobFailure(input, error);
        throw error;
      }
      return;
    }

    if (bullJob.data.type === "recompute-topics") {
      console.log(JSON.stringify({
        level: "info",
        event: "analysis.topics.recompute.started",
        jobId: commonInput.queueJobId,
        videoId: commonInput.videoId,
        attempt: commonInput.attemptNumber
      }));
      try {
        await recomputeTopics(commonInput, (progress) => bullJob.updateProgress(progress));
      } catch (error) {
        await recordJobFailure(commonInput, error);
        throw error;
      }
      return;
    }

    if (bullJob.data.type === "metadata") {
      if (!bullJob.data.clipId || !bullJob.data.options) throw new Error("The metadata job is missing its clip or generation options");
      const input = { ...commonInput, clipId: bullJob.data.clipId };
      console.log(JSON.stringify({
        level: "info",
        event: "clip.metadata.started",
        jobId: commonInput.queueJobId,
        clipId: input.clipId,
        videoId: input.videoId,
        attempt: input.attemptNumber
      }));
      try {
        await generateClipMetadata(input, (progress) => bullJob.updateProgress(progress));
      } catch (error) {
        await recordJobFailure(input, error);
        throw error;
      }
      return;
    }

    const input = {
      ...commonInput,
      modelSpeed: bullJob.data.modelSpeed === "fast" ? "fast" as const : "balanced" as const
    };
    console.log(JSON.stringify({
      level: "info",
      event: "analysis.started",
      jobId: input.queueJobId,
      videoId: input.videoId,
      attempt: input.attemptNumber
    }));

    try {
      await analyzeVideo(input, (progress) => bullJob.updateProgress(progress));
    } catch (error) {
      await recordJobFailure(input, error);
      throw error;
    }
  },
  { connection, concurrency: 1 }
);

queueWorker.on("completed", (job) => {
  console.log(JSON.stringify({ level: "info", event: "analysis.completed", jobId: job.id }));
});
queueWorker.on("failed", (job, error) => {
  console.error(JSON.stringify({
    level: "error",
    event: "analysis.attempt.failed",
    jobId: job?.id,
    attemptsMade: job?.attemptsMade,
    message: error.message
  }));
});
queueWorker.on("error", (error) => {
  console.error(JSON.stringify({ level: "error", event: "worker.error", message: error.message }));
});

await cleanupStaleWorkerDirectories(new Date(Date.now() - 24 * 60 * 60 * 1000));
await WorkerVideoModel.updateMany(
  { status: "processing", currentJobId: { $exists: false } },
  { $set: { status: "queued" } }
);

const staleCleanupInterval = setInterval(() => {
  void cleanupStaleWorkerDirectories(new Date(Date.now() - 24 * 60 * 60 * 1000)).catch((error: unknown) => {
    console.error(JSON.stringify({
      level: "error",
      event: "worker.temp.cleanup.failed",
      message: error instanceof Error ? error.message : "Unknown cleanup error"
    }));
  });
}, 60 * 60 * 1000);
staleCleanupInterval.unref();

console.log(JSON.stringify({
  level: "info",
  event: "worker.ready",
  queue: "video-analysis",
  concurrency: 1,
  whisperModel: config.whisperModelSize
}));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", event: "worker.shutdown", signal }));
  clearInterval(staleCleanupInterval);
  await queueWorker.close();
  await connection.quit();
  await mongoose.disconnect();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
