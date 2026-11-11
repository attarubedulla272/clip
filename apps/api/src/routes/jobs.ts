import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, statfs } from "node:fs/promises";
import { Types } from "mongoose";
import { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { validateParams } from "../middleware/validate.js";
import { Job, type JobProgress } from "../models/job.js";
import { User } from "../models/user.js";
import { Video } from "../models/video.js";
import { analysisQueue } from "../jobs/analysis-queue.js";
import { LocalDiskStorage } from "@clipforge/shared/storage";
import { probeMediaFile, enforceDurationLimit } from "@clipforge/shared/media-probe";
import { validateBody } from "../middleware/validate.js";
import { Transcript } from "../models/transcript.js";
import { Clip, type ReframeStrategy } from "../models/clip.js";
import { ClipMetadata } from "../models/clip-metadata.js";
import { metadataOptionsSchema } from "@clipforge/shared/clip-metadata";

const router = Router();
export function isAnalysisJobActive(status: string | undefined) {
  return status === "queued" || status === "processing";
}

export function canCancelAnalysisJobStatus(status: string | undefined) {
  return status === "queued" || status === "processing";
}
const videoParams = z.object({ videoId: z.string().regex(/^[a-f\d]{24}$/i) });
const jobParams = z.object({ jobId: z.string().regex(/^[a-f\d]{24}$/i) });
const clipParams = z.object({ clipId: z.string().regex(/^[a-f\d]{24}$/i) });
const MAX_ATTEMPTS = 3;
const analyzeBody = z.object({ modelSpeed: z.enum(["fast", "balanced"]).default("fast") });
const findClipsBody = z.object({ useGemini: z.boolean().default(false) });
const renderBody = z.object({ reframeStrategy: z.enum(["blur-fit", "center-crop"]).default("blur-fit") });
const metadataOptionsBody = metadataOptionsSchema;
const storage = new LocalDiskStorage(config.storageRoot);
const INITIAL_PROGRESS: JobProgress = {
  stage: "queued",
  message: "Waiting for a worker",
  percent: 0
};

router.use(requireAuth);

function publicJob(job: {
  _id: Types.ObjectId;
  queueJobId: string;
  type: "analysis" | "url-import" | "find-clips" | "render" | "metadata" | "recompute-topics";
  status: string;
  modelSpeed?: "fast" | "balanced";
  progress: JobProgress;
  attemptsMade: number;
  maxAttempts: number;
  failedReason?: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: job._id.toString(),
    queueJobId: job.queueJobId,
    type: job.type,
    status: job.status,
    modelSpeed: job.modelSpeed ?? "balanced",
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.maxAttempts,
    failedReason: job.failedReason,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

async function claimUserSlot(userId: string) {
  const user = await User.findOneAndUpdate(
    { _id: userId, activeAnalysisJobs: { $lt: config.maxConcurrentJobsPerUser } },
    { $inc: { activeAnalysisJobs: 1 } },
    { new: true }
  ).select("_id");
  if (!user) {
    throw new AppError(429, "You already have the maximum number of active analysis jobs");
  }
}

async function releaseUserSlot(userId: Types.ObjectId | string) {
  await User.updateOne({ _id: userId, activeAnalysisJobs: { $gt: 0 } }, { $inc: { activeAnalysisJobs: -1 } });
}

async function enqueueClipRender(userId: string, clip: InstanceType<typeof Clip>, reframeStrategy: ReframeStrategy) {
  if (!clip.selectedForRendering) throw new AppError(409, "Select this clip for rendering before starting a render");
  if (clip.renderStatus === "rendering" && clip.renderQueueJobId) {
    const activeJob = await Job.findOne({ queueJobId: clip.renderQueueJobId, userId });
    if (activeJob && isAnalysisJobActive(activeJob.status)) return activeJob;
  }
  const captionStyle = clip.captionStyle ?? "clean";
  const cleanupCaptionFillers = clip.cleanupCaptionFillers ?? true;
  if (clip.renderStatus === "ready" &&
    clip.renderSettings?.reframeStrategy === reframeStrategy &&
    clip.renderSettings?.captionStyle === captionStyle &&
    clip.renderSettings?.cleanupCaptionFillers === cleanupCaptionFillers) return null;

  const queueJobId = `render-${clip.id}-${randomUUID()}`;
  const job = await Job.create({
    queueJobId,
    userId,
    videoId: clip.videoId,
    clipId: clip._id,
    type: "render",
    status: "queued",
    progress: INITIAL_PROGRESS,
    attemptsMade: 0,
    maxAttempts: MAX_ATTEMPTS
  });
  try {
    await Clip.updateOne({ _id: clip._id }, {
      $set: {
        renderStatus: "rendering",
        renderJobId: job._id,
        renderQueueJobId: queueJobId,
        renderSettings: {
          reframeStrategy,
          captionStyle,
          cleanupCaptionFillers,
          width: 1080,
          height: 1920,
          videoCodec: "libx264",
          preset: "veryfast",
          crf: 23,
          threads: 2,
          audioCodec: "aac",
          pixelFormat: "yuv420p",
          faststart: true
        },
        renderProgress: { message: "Waiting for a render worker", percent: 0 }
      },
      $unset: { renderError: 1 }
    });
    await analysisQueue.add("render", {
      type: "render",
      userId,
      videoId: clip.videoId.toString(),
      clipId: clip.id,
      databaseJobId: job.id,
      reframeStrategy,
      captionStyle,
      cleanupCaptionFillers
    }, { jobId: queueJobId });
    return job;
  } catch (error) {
    const queuedJob = await analysisQueue.getJob(queueJobId);
    if (queuedJob) await queuedJob.remove();
    await Job.deleteOne({ _id: job._id });
    await Clip.updateOne({ _id: clip._id, renderQueueJobId: queueJobId }, {
      $set: { renderStatus: "not-rendered", renderProgress: { message: "Could not queue the render job", percent: 0 } },
      $unset: { renderQueueJobId: 1, renderJobId: 1 }
    });
    throw error;
  }
}

async function ensureRenderDiskSpace(clips: Array<InstanceType<typeof Clip>>) {
  await mkdir(config.storageRoot, { recursive: true, mode: 0o700 });
  const disk = await statfs(config.storageRoot);
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  const estimatedBytes = clips.reduce(
    (total, clip) => total + Math.max(16 * 1024 * 1024, (clip.end - clip.start) * 1_000_000),
    config.minFreeDiskBytes
  );
  if (availableBytes < estimatedBytes) {
    throw new AppError(507,
      `Insufficient disk space for rendering: ${(availableBytes / 1024 ** 2).toFixed(0)} MiB available; ` +
      `${(estimatedBytes / 1024 ** 2).toFixed(0)} MiB required including the configured reserve.`
    );
  }
}

router.post("/videos/:videoId/render-selected", validateParams(videoParams), validateBody(renderBody), async (req, res) => {
  const { videoId } = req.params as z.infer<typeof videoParams>;
  const userId = req.auth!.userId;
  const video = await Video.findOne({ _id: videoId, userId }).select("_id");
  if (!video) throw new AppError(404, "Video not found");
  const { reframeStrategy } = req.body as z.infer<typeof renderBody>;
  const selectedClips = await Clip.find({ videoId, selectedForRendering: true }).sort({ score: -1, start: 1 });
  if (selectedClips.length === 0) throw new AppError(409, "Select at least one clip before rendering.");
  await ensureRenderDiskSpace(selectedClips.filter((clip) =>
    clip.renderStatus !== "rendering" &&
    !(clip.renderStatus === "ready" &&
      clip.renderSettings?.reframeStrategy === reframeStrategy &&
      clip.renderSettings?.captionStyle === (clip.captionStyle ?? "clean") &&
      clip.renderSettings?.cleanupCaptionFillers === (clip.cleanupCaptionFillers ?? true))
  ));

  const queued: Array<ReturnType<typeof publicJob>> = [];
  for (const clip of selectedClips) {
    const job = await enqueueClipRender(userId, clip, reframeStrategy);
    if (job) queued.push(publicJob(job));
  }
  res.status(202).json({
    jobs: queued,
    message: queued.length > 0 ? `Queued ${queued.length} selected clip${queued.length === 1 ? "" : "s"} for rendering.` : "All selected clips already have matching renders."
  });
});

router.post("/clips/:clipId/render", validateParams(clipParams), validateBody(renderBody), async (req, res) => {
  const { clipId } = req.params as z.infer<typeof clipParams>;
  const userId = req.auth!.userId;
  const clip = await Clip.findById(clipId);
  if (!clip) throw new AppError(404, "Clip not found");
  const video = await Video.findOne({ _id: clip.videoId, userId }).select("_id");
  if (!video) throw new AppError(404, "Clip not found");
  const { reframeStrategy } = req.body as z.infer<typeof renderBody>;
  const activeRender = clip.renderStatus === "rendering" && clip.renderQueueJobId
    ? await Job.findOne({ queueJobId: clip.renderQueueJobId, userId }).select("status")
    : null;
  const hasActiveRender = activeRender && isAnalysisJobActive(activeRender.status);
  const matchingRender = clip.renderStatus === "ready" &&
    clip.renderSettings?.reframeStrategy === reframeStrategy &&
    clip.renderSettings?.captionStyle === (clip.captionStyle ?? "clean") &&
    clip.renderSettings?.cleanupCaptionFillers === (clip.cleanupCaptionFillers ?? true);
  if (!hasActiveRender && !matchingRender) await ensureRenderDiskSpace([clip]);
  const job = await enqueueClipRender(userId, clip, reframeStrategy);
  if (!job) {
    res.status(200).json({ renderStatus: "ready", message: "This clip already has a render with these settings." });
    return;
  }
  res.status(202).json({ job: publicJob(job) });
});

router.post("/clips/:clipId/render-preview", validateParams(clipParams), async (req, res) => {
  const { clipId } = req.params as z.infer<typeof clipParams>;
  const userId = req.auth!.userId;
  const clip = await Clip.findById(clipId);
  if (!clip) throw new AppError(404, "Clip not found");
  const video = await Video.findOne({ _id: clip.videoId, userId }).select("_id");
  if (!video) throw new AppError(404, "Clip not found");
  if (clip.renderStatus === "rendering") {
    throw new AppError(409, "Wait for the current full render to finish before previewing captions");
  }
  const activePreview = await Job.findOne({
    clipId: clip._id,
    userId,
    type: "render",
    captionPreview: true,
    status: { $in: ["queued", "processing", "retrying"] }
  });
  if (activePreview) throw new AppError(409, "Wait for the current caption preview to finish");

  const previewId = randomUUID();
  const queueJobId = `caption-preview-${clip.id}-${previewId}`;
  const previousPreviewPath = clip.captionPreviewFilePath;
  const job = await Job.create({
    queueJobId,
    userId,
    videoId: clip.videoId,
    clipId: clip._id,
    captionPreview: true,
    previewId,
    type: "render",
    status: "queued",
    progress: { stage: "queued", message: "Waiting for a render worker", percent: 0 },
    attemptsMade: 0,
    maxAttempts: MAX_ATTEMPTS
  });
  try {
    await Clip.updateOne({ _id: clip._id }, { $unset: { captionPreviewFilePath: 1 } });
    if (previousPreviewPath) await storage.delete(userId, previousPreviewPath);
    await analysisQueue.add("render", {
      type: "render",
      userId,
      videoId: clip.videoId.toString(),
      clipId: clip.id,
      databaseJobId: job.id,
      reframeStrategy: clip.renderSettings?.reframeStrategy ?? "blur-fit",
      captionStyle: clip.captionStyle ?? "clean",
      cleanupCaptionFillers: clip.cleanupCaptionFillers ?? true,
      captionPreview: true,
      previewId
    }, { jobId: queueJobId });
  } catch (error) {
    const queuedJob = await analysisQueue.getJob(queueJobId);
    if (queuedJob) await queuedJob.remove();
    await Job.deleteOne({ _id: job._id });
    throw error;
  }
  res.status(202).json({ job: publicJob(job) });
});

router.post("/clips/:clipId/metadata/generate", validateParams(clipParams), validateBody(metadataOptionsBody), async (req, res) => {
  const { clipId } = req.params as z.infer<typeof clipParams>;
  const userId = req.auth!.userId;
  const clip = await Clip.findById(clipId);
  if (!clip) throw new AppError(404, "Clip not found");
  const video = await Video.findOne({ _id: clip.videoId, userId });
  if (!video) throw new AppError(404, "Clip not found");
  if (!clip.selectedForRendering && clip.renderStatus !== "ready") {
    throw new AppError(409, "Select or render this clip before generating metadata");
  }
  const options = metadataOptionsBody.parse(req.body);
  const existingMetadata = await ClipMetadata.findOne({ clipId: clip._id, videoId: video._id });
  if (existingMetadata?.generationStatus && isAnalysisJobActive(existingMetadata.generationStatus)) {
    const activeJob = existingMetadata.generationJobId
      ? await Job.findOne({ _id: existingMetadata.generationJobId, userId })
      : null;
    if (activeJob && isAnalysisJobActive(activeJob.status)) {
      res.status(200).json({ job: publicJob(activeJob) });
      return;
    }
  }

  const queueJobId = `metadata-${clip.id}-${randomUUID()}`;
  const job = await Job.create({
    queueJobId,
    userId,
    videoId: video._id,
    clipId: clip._id,
    type: "metadata",
    status: "queued",
    progress: INITIAL_PROGRESS,
    attemptsMade: 0,
    maxAttempts: MAX_ATTEMPTS
  });
  try {
    const invalidateEditedResult = existingMetadata?.edited
      ? { $unset: { result: 1, mode: 1, provider: 1, warnings: 1, generatedAt: 1, contentHash: 1 } }
      : {};
    await ClipMetadata.findOneAndUpdate({ clipId: clip._id, videoId: video._id }, {
      $set: {
        language: options.language,
        tone: options.tone,
        includeOriginalCredit: video.source === "url" && options.includeOriginalCredit,
        useGemini: options.useGemini,
        generationStatus: "queued",
        generationJobId: job._id,
        generationProgress: { message: "Metadata worker starting; offline result will be available first", percent: 0 }
      },
      $unset: { generationError: 1, fallbackReason: 1 },
      ...invalidateEditedResult,
      $setOnInsert: { edited: false }
    }, { upsert: true, new: true, setDefaultsOnInsert: true });
    await analysisQueue.add("metadata", {
      type: "metadata",
      userId,
      videoId: video.id,
      clipId: clip.id,
      databaseJobId: job.id,
      options: { ...options, includeOriginalCredit: video.source === "url" && options.includeOriginalCredit }
    }, { jobId: queueJobId });
    res.status(202).json({ job: publicJob(job) });
  } catch (error) {
    await Job.deleteOne({ _id: job._id });
    await ClipMetadata.updateOne({ clipId: clip._id, generationJobId: job._id }, {
      $set: { generationStatus: "failed", generationError: "Could not queue metadata generation" },
      $unset: { generationJobId: 1 }
    });
    throw error;
  }
});

router.post("/videos/:videoId/analyze", validateParams(videoParams), validateBody(analyzeBody), async (req, res) => {
  const video = await Video.findOne({ _id: req.params.videoId, userId: req.auth?.userId });
  if (!video) throw new AppError(404, "Video not found");
  if (typeof video.durationSeconds !== "number" || !Number.isFinite(video.durationSeconds) || video.durationSeconds <= 0) {
    const media = await probeMediaFile(storage.pathFor(video.userId.toString(), video.storageKey), config.ffprobePath);
    video.durationSeconds = media.durationSeconds;
    video.hasAudio = media.hasAudio;
    video.hasVideo = media.hasVideo;
    await video.save();
  }
  enforceDurationLimit(video.durationSeconds, config.maxVideoDurationSeconds);
  if (!video.hasAudio) {
    throw new AppError(422, "This video has no audio stream to transcribe");
  }
  const { modelSpeed } = req.body as z.infer<typeof analyzeBody>;

  const queueJobId = `analysis-${video.id}`;
  let existing = await Job.findOne({ queueJobId, userId: req.auth?.userId });
  if (existing) {
    if (existing.status === "queued" || existing.status === "processing" || existing.status === "retrying") {
      const queuedJob = await analysisQueue.getJob(queueJobId);
      if (!queuedJob) {
        await analysisQueue.add("analyze", {
          type: "analysis",
          userId: video.userId.toString(),
          videoId: video.id,
          databaseJobId: existing.id,
          modelSpeed: existing.modelSpeed ?? modelSpeed
        }, { jobId: queueJobId });
      }
    }
    res.status(200).json({ job: publicJob(existing) });
    return;
  }

  await claimUserSlot(video.userId.toString());
  let createdJobId: Types.ObjectId | undefined;
  try {
    const job = await Job.create({
      queueJobId,
      userId: video.userId,
      videoId: video._id,
      type: "analysis",
      modelSpeed,
      status: "queued",
      progress: INITIAL_PROGRESS,
      attemptsMade: 0,
      maxAttempts: MAX_ATTEMPTS
    });
    createdJobId = job._id;
    video.status = "queued";
    video.currentJobId = job._id;
    video.set("analysisError", undefined);
    await video.save();
    try {
      await analysisQueue.add("analyze", {
        type: "analysis",
        userId: video.userId.toString(),
        videoId: video.id,
        databaseJobId: job.id,
        modelSpeed
      }, { jobId: queueJobId });
    } catch (error) {
      await Job.deleteOne({ _id: job._id });
      await Video.updateOne(
        { _id: video._id, userId: video.userId },
        { $set: { status: "uploaded" }, $unset: { currentJobId: 1, analysisError: 1 } }
      );
      throw error;
    }
    res.status(202).json({ job: publicJob(job) });
  } catch (error) {
    if (createdJobId) await Job.deleteOne({ _id: createdJobId });
    await releaseUserSlot(video.userId);
    throw error;
  }
});

router.post("/videos/:videoId/find-clips", validateParams(videoParams), validateBody(findClipsBody), async (req, res) => {
  const userId = req.auth!.userId;
  const { useGemini } = req.body as z.infer<typeof findClipsBody>;
  const video = await Video.findOne({ _id: req.params.videoId, userId });
  if (!video) throw new AppError(404, "Video not found");
  if (video.status !== "ready") throw new AppError(409, "Analyze this video before looking for clips.");
  const transcript = await Transcript.findOne({ videoId: video._id }).select("_id");
  if (!transcript) throw new AppError(409, "The transcript is not ready yet. Analyze the video first.");

  const existing = await Job.findOne({ videoId: video._id, userId, type: "find-clips" }).sort({ createdAt: -1 });
  if (existing && isAnalysisJobActive(existing.status)) {
    const queuedJob = await analysisQueue.getJob(existing.queueJobId);
    if (!queuedJob) {
      await analysisQueue.add("find-clips", {
        type: "find-clips",
        useGemini: existing.useGemini,
        userId,
        videoId: video.id,
        databaseJobId: existing.id
      }, { jobId: existing.queueJobId });
    }
    res.status(200).json({ job: publicJob(existing) });
    return;
  }

  await claimUserSlot(userId);
  let createdJobId: Types.ObjectId | undefined;
  try {
    const job = await Job.create({
      queueJobId: `clips-${video.id}-${randomUUID()}`,
      userId: video.userId,
      videoId: video._id,
      type: "find-clips",
      useGemini,
      status: "queued",
      progress: INITIAL_PROGRESS,
      attemptsMade: 0,
      maxAttempts: MAX_ATTEMPTS
    });
    createdJobId = job._id;
    await analysisQueue.add("find-clips", {
      type: "find-clips",
      useGemini,
      userId,
      videoId: video.id,
      databaseJobId: job.id
    }, { jobId: job.queueJobId });
    res.status(202).json({ job: publicJob(job) });
  } catch (error) {
    if (createdJobId) await Job.deleteOne({ _id: createdJobId });
    await releaseUserSlot(video.userId);
    throw error;
  }
});

router.post("/videos/:videoId/recompute-topics", validateParams(videoParams), async (req, res) => {
  const userId = req.auth!.userId;
  const video = await Video.findOne({ _id: req.params.videoId, userId });
  if (!video) throw new AppError(404, "Video not found");
  if (video.status !== "ready") throw new AppError(409, "Analyze and save the transcript before recomputing topic boundaries.");

  const transcript = await Transcript.findOne({ videoId: video._id }).select("_id");
  if (!transcript) throw new AppError(409, "The transcript is not ready yet. Analyze the video first.");

  const existing = await Job.findOne({ videoId: video._id, userId, type: "recompute-topics" }).sort({ createdAt: -1 });
  if (existing && isAnalysisJobActive(existing.status)) {
    const queuedJob = await analysisQueue.getJob(existing.queueJobId);
    if (!queuedJob) {
      await analysisQueue.add("recompute-topics", {
        type: "recompute-topics",
        userId,
        videoId: video.id,
        databaseJobId: existing.id
      }, { jobId: existing.queueJobId });
    }
    res.status(200).json({ job: publicJob(existing) });
    return;
  }

  await claimUserSlot(userId);
  let createdJobId: Types.ObjectId | undefined;
  try {
    const job = await Job.create({
      queueJobId: `topics-${video.id}-${randomUUID()}`,
      userId: video.userId,
      videoId: video._id,
      type: "recompute-topics",
      status: "queued",
      progress: INITIAL_PROGRESS,
      attemptsMade: 0,
      maxAttempts: MAX_ATTEMPTS
    });
    createdJobId = job._id;
    await analysisQueue.add("recompute-topics", {
      type: "recompute-topics",
      userId,
      videoId: video.id,
      databaseJobId: job.id
    }, { jobId: job.queueJobId });
    res.status(202).json({ job: publicJob(job) });
  } catch (error) {
    if (createdJobId) await Job.deleteOne({ _id: createdJobId });
    await releaseUserSlot(video.userId);
    throw error;
  }
});

router.get("/jobs/:jobId", validateParams(jobParams), async (req, res) => {
  const job = await Job.findOne({ _id: req.params.jobId, userId: req.auth?.userId });
  if (!job) throw new AppError(404, "Job not found");
  res.json({ job: publicJob(job) });
});

router.get("/jobs/:jobId/events", validateParams(jobParams), async (req, res) => {
  const job = await Job.findOne({ _id: req.params.jobId, userId: req.auth?.userId });
  if (!job) throw new AppError(404, "Job not found");

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  let lastEvent = "";
  let closed = false;
  let interval: NodeJS.Timeout;

  const send = (payload: unknown) => {
    const serialized = JSON.stringify(payload);
    if (serialized !== lastEvent) {
      res.write(`data: ${serialized}\n\n`);
      lastEvent = serialized;
    }
  };

  const publish = async () => {
    if (closed) return;
    try {
      const latest = await Job.findOne({ _id: job._id, userId: req.auth?.userId });
      if (!latest) {
        res.write("event: error\ndata: {\"error\":\"Job not found\"}\n\n");
        closed = true;
        clearInterval(interval);
        res.end();
        return;
      }
      send({ job: publicJob(latest) });
      if (latest.status === "completed" || latest.status === "failed") {
        closed = true;
        clearInterval(interval);
        res.end();
      }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "jobs.sse.error", jobId: job.id, message: error instanceof Error ? error.message : "Unknown error" }));
      res.write("event: error\ndata: {\"error\":\"Could not load job progress\"}\n\n");
      closed = true;
      clearInterval(interval);
      res.end();
    }
  };

  interval = setInterval(() => void publish(), 1_000);
  interval.unref();
  res.on("close", () => {
    closed = true;
    clearInterval(interval);
  });
  void publish();
});

router.post("/jobs/:jobId/cancel", validateParams(jobParams), async (req, res) => {
  const job = await Job.findOne({ _id: req.params.jobId, userId: req.auth?.userId });
  if (!job) throw new AppError(404, "Job not found");
  if (["completed", "failed"].includes(job.status)) throw new AppError(409, "Only queued or running jobs can be cancelled");

  const queuedJob = await analysisQueue.getJob(job.queueJobId);
  if (queuedJob) {
    const state = await queuedJob.getState();
    if (["waiting", "active", "delayed", "waiting-children", "prioritized"].includes(state)) {
      await queuedJob.remove();
    }
  }

  job.status = "failed";
  job.progress = { stage: "failed", message: "Cancelled by user", percent: 0 };
  job.failedReason = "Cancelled by user";
  job.completedAt = new Date();
  await job.save();

  if (job.type === "analysis" || job.type === "url-import") {
    await Video.updateOne(
      { _id: job.videoId, userId: job.userId },
      { $set: { status: "failed", analysisError: "Cancelled by user" }, $unset: { currentJobId: 1 } }
    );
  }
  if (job.type === "render" && job.clipId && !job.captionPreview) {
    await Clip.updateOne(
      { _id: job.clipId, videoId: job.videoId },
      { $set: { renderStatus: "failed", renderError: "Cancelled by user", renderProgress: { message: "Cancelled by user", percent: 0 } } }
    );
  }
  if (job.type === "metadata" && job.clipId) {
    await ClipMetadata.updateOne(
      { clipId: job.clipId, videoId: job.videoId },
      {
        $set: {
          generationStatus: "failed",
          generationError: "Cancelled by user",
          generationProgress: { message: "Cancelled by user", percent: 0 }
        }
      }
    );
  }
  if (job.type !== "render" && job.type !== "metadata") {
    await User.updateOne({ _id: job.userId, activeAnalysisJobs: { $gt: 0 } }, { $inc: { activeAnalysisJobs: -1 } });
  }

  res.status(202).json({ job: publicJob(job) });
});

router.post("/jobs/:jobId/retry", validateParams(jobParams), async (req, res) => {
  const job = await Job.findOne({ _id: req.params.jobId, userId: req.auth?.userId });
  if (!job) throw new AppError(404, "Job not found");
  if (job.status !== "failed") throw new AppError(409, "Only failed jobs can be retried");

  const claimsAnalysisSlot = job.type !== "render" && job.type !== "metadata";
  if (claimsAnalysisSlot) await claimUserSlot(job.userId.toString());
  let savedForRetry = false;
  let retryEnqueued = false;
  const previousFailureReason = job.failedReason ?? "The previous analysis attempt failed";
  try {
    const video = await Video.findOne({ _id: job.videoId, userId: job.userId }).select("sourceUrl").lean();
    if (job.type === "url-import" && !video?.sourceUrl) {
      throw new AppError(422, "The original YouTube link is unavailable; upload the video file instead.");
    }
    if (job.type === "render") {
      if (!job.clipId) throw new AppError(422, "The failed render job has no clip reference");
      const clip = await Clip.findOne({ _id: job.clipId, videoId: job.videoId });
      if (!clip) throw new AppError(422, "The clip for this render job is unavailable");
      if (!job.captionPreview && !clip.selectedForRendering) throw new AppError(409, "Select this clip for rendering before retrying");
      if (!job.captionPreview && !clip.renderSettings) throw new AppError(422, "The render settings for this clip are unavailable");
    }
    if (job.type === "metadata") {
      if (!job.clipId) throw new AppError(422, "The metadata job has no clip reference");
      const [clip, metadata] = await Promise.all([
        Clip.findOne({ _id: job.clipId, videoId: job.videoId }),
        ClipMetadata.findOne({ clipId: job.clipId, videoId: job.videoId })
      ]);
      if (!clip || !metadata) throw new AppError(422, "The clip metadata settings are unavailable");
      if (!clip.selectedForRendering && clip.renderStatus !== "ready") {
        throw new AppError(409, "Select or render this clip before retrying metadata generation");
      }
    }
    const queuedJob = await analysisQueue.getJob(job.queueJobId);
    if (queuedJob) {
      const state = await queuedJob.getState();
      if (state !== "failed") throw new AppError(409, "The analysis job is not ready to retry");
    }

    job.status = "queued";
    job.progress = INITIAL_PROGRESS;
    job.attemptsMade = 0;
    job.set("failedReason", undefined);
    job.set("completedAt", undefined);
    await job.save();
    savedForRetry = true;
    if (job.type === "analysis" || job.type === "url-import") {
      await Video.updateOne(
        { _id: job.videoId, userId: job.userId },
        { $set: { status: "queued", currentJobId: job._id }, $unset: { analysisError: 1 } }
      );
    }
    if (job.type === "render" && job.clipId && !job.captionPreview) {
      await Clip.updateOne({ _id: job.clipId, videoId: job.videoId }, {
        $set: { renderStatus: "rendering", renderProgress: { message: "Waiting for a render worker", percent: 0 } },
        $unset: { renderError: 1 }
      });
    }
    if (job.type === "metadata" && job.clipId) {
      await ClipMetadata.updateOne({ clipId: job.clipId, videoId: job.videoId }, {
        $set: {
          generationStatus: "queued",
          generationJobId: job._id,
          generationProgress: { message: "Waiting for a metadata worker", percent: 0 }
        },
        $unset: { generationError: 1, fallbackReason: 1 }
      });
    }
    if (queuedJob) {
      await queuedJob.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
    } else {
      if (job.type === "url-import") {
        await analysisQueue.add("url-import", {
          type: "url-import",
          userId: job.userId.toString(),
          videoId: job.videoId.toString(),
          databaseJobId: job.id,
          sourceUrl: video!.sourceUrl!
        }, { jobId: job.queueJobId });
      } else if (job.type === "find-clips") {
        await analysisQueue.add("find-clips", {
          type: "find-clips",
          userId: job.userId.toString(),
          videoId: job.videoId.toString(),
          databaseJobId: job.id
        }, { jobId: job.queueJobId });
      } else if (job.type === "render") {
        const clip = await Clip.findOne({ _id: job.clipId, videoId: job.videoId });
        if (!clip) throw new AppError(422, "The clip for this render job is unavailable");
        if (!job.captionPreview && !clip.renderSettings) throw new AppError(422, "The render settings for this clip are unavailable");
        await analysisQueue.add("render", {
          type: "render",
          userId: job.userId.toString(),
          videoId: job.videoId.toString(),
          clipId: clip.id,
          databaseJobId: job.id,
          reframeStrategy: clip.renderSettings?.reframeStrategy ?? "blur-fit",
          captionStyle: clip.captionStyle ?? "clean",
          cleanupCaptionFillers: clip.cleanupCaptionFillers ?? true,
          captionPreview: job.captionPreview,
          ...(job.previewId ? { previewId: job.previewId } : {})
        }, { jobId: job.queueJobId });
      } else if (job.type === "metadata") {
        const metadata = await ClipMetadata.findOne({ clipId: job.clipId, videoId: job.videoId });
        if (!metadata) throw new AppError(422, "The clip metadata settings are unavailable");
        await analysisQueue.add("metadata", {
          type: "metadata",
          userId: job.userId.toString(),
          videoId: job.videoId.toString(),
          clipId: job.clipId!.toString(),
          databaseJobId: job.id,
          options: {
            language: metadata.language,
            tone: metadata.tone,
            includeOriginalCredit: metadata.includeOriginalCredit,
            useGemini: metadata.useGemini
          }
        }, { jobId: job.queueJobId });
      } else {
        await analysisQueue.add("analyze", {
          type: "analysis",
          userId: job.userId.toString(),
          videoId: job.videoId.toString(),
          databaseJobId: job.id,
          modelSpeed: job.modelSpeed ?? "balanced"
        }, { jobId: job.queueJobId });
      }
    }
    retryEnqueued = true;
    res.status(202).json({ job: publicJob(job) });
  } catch (error) {
    try {
      if (savedForRetry && !retryEnqueued) {
        job.status = "failed";
        job.progress = { stage: "failed", message: previousFailureReason, percent: 0 };
        job.failedReason = previousFailureReason;
        job.completedAt = new Date();
        await job.save();
        if (job.type === "analysis" || job.type === "url-import") {
          await Video.updateOne(
            { _id: job.videoId, userId: job.userId },
            { $set: { status: "failed", analysisError: previousFailureReason } }
          );
        }
        if (job.type === "render" && job.clipId) {
          await Clip.updateOne({ _id: job.clipId, videoId: job.videoId }, {
            $set: { renderStatus: "failed", renderError: previousFailureReason, renderProgress: { message: previousFailureReason, percent: 0 } }
          });
        }
        if (job.type === "metadata" && job.clipId) {
          await ClipMetadata.updateOne({ clipId: job.clipId, videoId: job.videoId }, {
            $set: {
              generationStatus: "failed",
              generationError: previousFailureReason,
              generationProgress: { message: previousFailureReason, percent: 0 }
            }
          });
        }
      }
    } finally {
      if (!retryEnqueued && claimsAnalysisSlot) await releaseUserSlot(job.userId);
    }
    throw error;
  }
});

export default router;
