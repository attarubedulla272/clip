import { randomUUID } from "node:crypto";
import { mkdir, statfs } from "node:fs/promises";
import { Router } from "express";
import { Types } from "mongoose";
import { enforceUrlImportLimits, parseYtDlpMetadata, validateYouTubeUrl } from "@clipforge/shared/url-import";
import { fetchYtDlpMetadata } from "@clipforge/shared/yt-dlp";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { analysisQueue } from "../jobs/analysis-queue.js";
import { Job } from "../models/job.js";
import { Project } from "../models/project.js";
import { UploadSession } from "../models/upload-session.js";
import { User } from "../models/user.js";
import { Video } from "../models/video.js";
import { z } from "zod";

const router = Router();
const projectParams = z.object({ projectId: z.string().regex(/^[a-f\d]{24}$/i) });
const metadataBody = z.object({ sourceUrl: z.string().min(1).max(2048) });
const importBody = metadataBody.extend({ rightsConfirmed: z.literal(true) });
const INITIAL_PROGRESS = { stage: "queued", message: "Waiting for a worker", percent: 0 };

router.use(requireAuth);

async function loadMetadata(sourceUrl: string) {
  let canonicalUrl: string;
  try {
    canonicalUrl = validateYouTubeUrl(sourceUrl);
  } catch (error) {
    throw new AppError(400, error instanceof Error ? error.message : "Invalid YouTube video link");
  }
  try {
    const raw = await fetchYtDlpMetadata(canonicalUrl, config.ytDlpPath);
    const metadata = parseYtDlpMetadata(raw);
    if (metadata.id !== new URL(canonicalUrl).searchParams.get("v")) {
      throw new Error("YouTube returned metadata for a different video link.");
    }
    enforceUrlImportLimits(metadata, config.maxVideoDurationSeconds, config.maxUploadBytes);
    return { canonicalUrl, metadata };
  } catch (error) {
    throw new AppError(422, error instanceof Error ? error.message : "Could not read YouTube video metadata");
  }
}

router.post(
  "/:projectId/import-metadata",
  validateParams(projectParams),
  validateBody(metadataBody),
  async (req, res) => {
    const project = await Project.findOne({ _id: req.params.projectId, userId: req.auth!.userId }).select("_id");
    if (!project) throw new AppError(404, "Project not found");
    const { canonicalUrl, metadata } = await loadMetadata((req.body as z.infer<typeof metadataBody>).sourceUrl);
    res.json({
      sourceUrl: canonicalUrl,
      metadata,
      limits: { maxVideoDurationSeconds: config.maxVideoDurationSeconds, maxUploadBytes: config.maxUploadBytes }
    });
  }
);

router.post(
  "/:projectId/imports",
  validateParams(projectParams),
  validateBody(importBody),
  async (req, res) => {
    const userId = req.auth!.userId;
    const project = await Project.findOne({ _id: req.params.projectId, userId }).select("_id");
    if (!project) throw new AppError(404, "Project not found");
    const { canonicalUrl, metadata } = await loadMetadata((req.body as z.infer<typeof importBody>).sourceUrl);

    const previousImport = await Video.findOne({ userId, projectId: project._id, sourceUrl: canonicalUrl });
    if (previousImport) {
      const existingJob = await Job.findOne({ videoId: previousImport._id, userId, type: "url-import" }).sort({ createdAt: -1 });
      if (existingJob) {
        res.status(200).json({ video: previousImport, job: publicImportJob(existingJob) });
        return;
      }
    }

    await mkdir(config.storageRoot, { recursive: true, mode: 0o700 });
    const disk = await statfs(config.storageRoot);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    const outstanding = await UploadSession.aggregate<{ reservedBytes: number }>([
      { $match: { status: "uploading", expiresAt: { $gt: new Date() } } },
      { $group: { _id: null, reservedBytes: { $sum: { $subtract: ["$expectedSizeBytes", "$offsetBytes"] } } } }
    ]);
    const reservedBytes = outstanding[0]?.reservedBytes ?? 0;
    const requiredBytes = metadata.estimatedSizeBytes + config.minFreeDiskBytes;
    if (availableBytes - reservedBytes < requiredBytes) {
      const availableGiB = Math.max(0, (availableBytes - reservedBytes) / 1024 ** 3).toFixed(2);
      const requiredGiB = (requiredBytes / 1024 ** 3).toFixed(2);
      throw new AppError(507, `Insufficient disk space: ${availableGiB} GiB available; ${requiredGiB} GiB required including the free-space reserve`);
    }

    const user = await User.findOneAndUpdate(
      { _id: userId, activeAnalysisJobs: { $lt: config.maxConcurrentJobsPerUser } },
      { $inc: { activeAnalysisJobs: 1 } },
      { new: true }
    ).select("_id");
    if (!user) throw new AppError(429, "You already have the maximum number of active analysis jobs");

    const videoId = previousImport?._id ?? new Types.ObjectId();
    const databaseJobId = new Types.ObjectId();
    const queueJobId = `url-import-${videoId.toString()}-${randomUUID()}`;
    let videoCreated = false;
    try {
      const video = await Video.findOneAndUpdate(
        { _id: videoId, userId },
        {
          $set: {
            userId,
            projectId: project._id,
            source: "url",
            sourceUrl: canonicalUrl,
            sourceTitle: metadata.title,
            channel: metadata.channel,
            originalName: metadata.title,
            storageKey: `videos/${videoId.toString()}.mp4`,
            sizeBytes: metadata.estimatedSizeBytes,
            durationSeconds: metadata.durationSeconds,
            hasAudio: true,
            hasVideo: true,
            status: "queued",
            currentJobId: databaseJobId
          },
          $unset: { analysisError: 1 }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      videoCreated = true;
      const job = await Job.create({
        _id: databaseJobId,
        queueJobId,
        userId,
        videoId: video._id,
        type: "url-import",
        modelSpeed: "balanced",
        status: "queued",
        progress: INITIAL_PROGRESS,
        attemptsMade: 0,
        maxAttempts: 3
      });
      try {
        await analysisQueue.add("url-import", {
          type: "url-import",
          userId,
          videoId: video.id,
          databaseJobId: job.id,
          sourceUrl: canonicalUrl
        }, { jobId: queueJobId });
      } catch (error) {
        await Job.deleteOne({ _id: job._id });
        throw error;
      }
      res.status(202).json({ video, job: publicImportJob(job) });
    } catch (error) {
      if (videoCreated) {
        await Video.updateOne(
          { _id: videoId, userId },
          { $set: { status: "failed", analysisError: "Could not queue the video import." } }
        );
      }
      await User.updateOne({ _id: userId, activeAnalysisJobs: { $gt: 0 } }, { $inc: { activeAnalysisJobs: -1 } });
      throw error;
    }
  }
);

function publicImportJob(job: {
  _id: { toString(): string };
  type: string;
  status: string;
  progress: typeof INITIAL_PROGRESS;
  attemptsMade: number;
  maxAttempts: number;
  failedReason?: string;
}) {
  return {
    id: job._id.toString(),
    type: job.type,
    status: job.status,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.maxAttempts,
    failedReason: job.failedReason
  };
}

export default router;
