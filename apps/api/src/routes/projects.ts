import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { Router } from "express";
import { mkdir, statfs } from "node:fs/promises";
import { createProjectSchema, uploadVideoParamsSchema } from "@clipforge/shared";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { Job } from "../models/job.js";
import { Analysis } from "../models/analysis.js";
import { Project } from "../models/project.js";
import { Transcript } from "../models/transcript.js";
import { Video } from "../models/video.js";
import { LocalDiskStorage } from "@clipforge/shared/storage";
import { UploadSession } from "../models/upload-session.js";
import { Clip } from "../models/clip.js";
import { ClipMetadata } from "../models/clip-metadata.js";
import { z } from "zod";
import { probeMediaFile } from "@clipforge/shared/media-probe";

const router = Router();
const storage = new LocalDiskStorage(config.storageRoot);
const allowedTypes = new Map([
  [".mp4", new Set(["video/mp4"])],
  [".m4v", new Set(["video/mp4", "video/x-m4v"])],
  [".mov", new Set(["video/quicktime"])],
  [".mkv", new Set(["video/x-matroska"])],
  [".webm", new Set(["video/webm"])]
]);
const createUploadSchema = z.object({
  originalName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().max(100).default("")
});

router.use(requireAuth);

router.get("/limits", (_req, res) => {
  res.json({
    maxUploadBytes: config.maxUploadBytes,
    maxVideoDurationSeconds: config.maxVideoDurationSeconds,
    uploadChunkBytes: config.uploadChunkBytes,
    minimumFreeDiskBytes: config.minFreeDiskBytes,
    minimumFreeDiskReserveBytes: config.minFreeDiskBytes
  });
});

router.get("/", async (req, res) => {
  const projects = await Project.find({ userId: req.auth?.userId }).sort({ updatedAt: -1 }).lean();
  res.json({ projects });
});

router.post("/", validateBody(createProjectSchema), async (req, res) => {
  const { name } = req.body as { name: string };
  const project = await Project.create({ userId: req.auth?.userId, name });
  res.status(201).json({ project });
});

router.post(
  "/:projectId/uploads",
  validateParams(uploadVideoParamsSchema),
  validateBody(createUploadSchema),
  async (req, res) => {
    const project = await Project.findOne({ _id: req.params.projectId, userId: req.auth?.userId }).select("_id");
    if (!project || !req.auth) throw new AppError(404, "Project not found");
    const { originalName, sizeBytes, contentType } = req.body as z.infer<typeof createUploadSchema>;
    if (sizeBytes > config.maxUploadBytes) {
      throw new AppError(413, `File is larger than the configured ${config.maxUploadBytes}-byte upload limit`);
    }

    const extension = extname(originalName).toLowerCase();
    const supportedTypes = allowedTypes.get(extension);
    if (!supportedTypes || (contentType && !supportedTypes.has(contentType))) {
      throw new AppError(415, "Unsupported video format. Use MP4, MOV, MKV, or WebM.");
    }

    await mkdir(config.storageRoot, { recursive: true, mode: 0o700 });
    const disk = await statfs(config.storageRoot);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    const outstanding = await UploadSession.aggregate<{ reservedBytes: number }>([
      { $match: { status: "uploading", expiresAt: { $gt: new Date() } } },
      { $group: { _id: null, reservedBytes: { $sum: { $subtract: ["$expectedSizeBytes", "$offsetBytes"] } } } }
    ]);
    const reservedBytes = outstanding[0]?.reservedBytes ?? 0;
    const requiredBytes = sizeBytes + config.minFreeDiskBytes;
    if (availableBytes - reservedBytes < requiredBytes) {
      const availableGiB = Math.max(0, (availableBytes - reservedBytes) / 1024 ** 3).toFixed(2);
      const requiredGiB = (requiredBytes / 1024 ** 3).toFixed(2);
      throw new AppError(507, `Insufficient disk space: ${availableGiB} GiB available; ${requiredGiB} GiB required including the free-space reserve`);
    }

    const uploadId = randomUUID();
    const storageKey = `tmp/uploads/${uploadId}.part`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await storage.createEmptyFile(req.auth.userId, storageKey);
    try {
      const session = await UploadSession.create({
        _id: uploadId,
        userId: req.auth.userId,
        projectId: project._id,
        originalName,
        contentType: contentType || supportedTypes.values().next().value,
        expectedSizeBytes: sizeBytes,
        offsetBytes: 0,
        storageKey,
        expiresAt
      });
      res.status(201).json({
        uploadId: session.id,
        offsetBytes: session.offsetBytes,
        expectedSizeBytes: session.expectedSizeBytes,
        chunkSizeBytes: config.uploadChunkBytes,
        expiresAt: session.expiresAt
      });
    } catch (error) {
      await storage.delete(req.auth.userId, storageKey);
      throw error;
    }
  }
);

router.get(
  "/:projectId/videos",
  validateParams(uploadVideoParamsSchema),
  async (req, res) => {
    const project = await Project.findOne({ _id: req.params.projectId, userId: req.auth?.userId }).select("_id");
    if (!project) {
      throw new AppError(404, "Project not found");
    }
    const storedVideos = await Video.find({ projectId: project._id, userId: req.auth?.userId })
      .select("userId storageKey originalName sizeBytes status createdAt durationSeconds hasAudio hasVideo detectedType analysisError source sourceUrl sourceTitle channel")
      .sort({ createdAt: -1 })
      .lean();
    const videos = await Promise.all(storedVideos.map(async (video) => {
      if (typeof video.durationSeconds === "number" && Number.isFinite(video.durationSeconds) && video.durationSeconds > 0) {
        return video;
      }
      const media = await probeMediaFile(
        storage.pathFor(video.userId.toString(), video.storageKey),
        config.ffprobePath
      );
      await Video.updateOne(
        { _id: video._id, userId: video.userId },
        { $set: { durationSeconds: media.durationSeconds, hasAudio: media.hasAudio, hasVideo: media.hasVideo } }
      );
      return { ...video, durationSeconds: media.durationSeconds, hasAudio: media.hasAudio, hasVideo: media.hasVideo };
    }));
    const videoIds = videos.map((video) => video._id);
    const jobs = await Job.find({ videoId: { $in: videoIds }, userId: req.auth?.userId })
      .where("type").ne("metadata")
      .select("videoId _id queueJobId type status progress attemptsMade maxAttempts failedReason updatedAt")
      .sort({ createdAt: -1 })
      .lean();
    const latestJobByVideo = new Map<string, typeof jobs[number]>();
    for (const job of jobs) {
      if (!latestJobByVideo.has(job.videoId.toString())) latestJobByVideo.set(job.videoId.toString(), job);
    }
    const [analyses, transcripts, clips, metadataRows, findClipJobs] = await Promise.all([
      Analysis.find({ videoId: { $in: videoIds } }).select("videoId videoType topicSegments topicsMode topicWarning heuristics").lean(),
      Transcript.find({ videoId: { $in: videoIds } }).select("videoId language wordCount segments").lean(),
      Clip.find({ videoId: { $in: videoIds }, isStaged: { $ne: true } })
        .select("videoId start end transcriptText signalsFound reason score breakdown scoringMode topicId topicLabel factorBreakdown boundaryQualityScore boundaryQualityReason boundaryChanges standaloneCheck selectedForRendering captionStyle cleanupCaptionFillers captionPreviewFilePath renderStatus renderFilePath renderSettings renderedAt renderError renderJobId renderQueueJobId renderProgress")
        .sort({ score: -1, start: 1 })
        .lean(),
      ClipMetadata.find({ videoId: { $in: videoIds } })
        .select("clipId contentHash result mode provider fallbackReason warnings trendSignals edited language tone includeOriginalCredit useGemini generationStatus generationJobId generationProgress generationError generatedAt")
        .lean(),
      Job.find({ videoId: { $in: videoIds }, userId: req.auth?.userId, type: "find-clips" })
        .select("videoId status createdAt completedAt findClipsDiagnostics")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean()
    ]);
    const analysisByVideo = new Map(analyses.map((analysis) => [analysis.videoId.toString(), analysis]));
    const transcriptByVideo = new Map(transcripts.map((transcript) => [transcript.videoId.toString(), transcript]));
    const metadataByClip = new Map(metadataRows.map((metadata) => [metadata.clipId.toString(), metadata]));
    const findClipsRunsByVideo = new Map<string, typeof findClipJobs>();
    for (const run of findClipJobs) {
      const videoKey = run.videoId.toString();
      const runs = findClipsRunsByVideo.get(videoKey) ?? [];
      if (runs.length >= 10) continue;
      runs.push(run);
      findClipsRunsByVideo.set(videoKey, runs);
    }
    const clipsByVideo = new Map<string, typeof clips>();
    for (const clip of clips) {
      const videoKey = clip.videoId.toString();
      const videoClips = clipsByVideo.get(videoKey) ?? [];
      videoClips.push(clip);
      clipsByVideo.set(videoKey, videoClips);
    }
    res.json({
      videos: videos.map((video) => ({
        ...video,
        job: (() => {
          const job = latestJobByVideo.get(video._id.toString());
          return job ? {
            id: job._id.toString(),
            type: job.type,
            status: job.status,
            progress: job.progress,
            attemptsMade: job.attemptsMade,
            maxAttempts: job.maxAttempts,
            failedReason: job.failedReason
          } : null;
        })(),
        analysis: analysisByVideo.get(video._id.toString()) ?? null,
        transcript: transcriptByVideo.get(video._id.toString()) ?? null,
        findClipsRuns: (findClipsRunsByVideo.get(video._id.toString()) ?? []).map((run) => ({
          id: run._id.toString(),
          status: run.status,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          diagnostics: run.findClipsDiagnostics
        })),
        clips: (clipsByVideo.get(video._id.toString()) ?? []).map((clip) => ({
          ...clip,
          metadata: metadataByClip.get(clip._id.toString()) ?? null
        }))
      }))
    });
  }
);

export default router;
