import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { enforceUrlImportLimits, parseYtDlpMetadata, validateYouTubeUrl } from "@clipforge/shared/url-import";
import { executeYtDlp, fetchYtDlpMetadata } from "@clipforge/shared/yt-dlp";
import { enforceDurationLimit, probeMediaFile } from "@clipforge/shared/media-probe";
import { LocalDiskStorage } from "@clipforge/shared/storage";
import { WorkerJobModel, WorkerUserModel, WorkerVideoModel } from "../models.js";

interface ImportInput {
  userId: string;
  videoId: string;
  databaseJobId: string;
  sourceUrl: string;
  attemptNumber: number;
}

interface ImportProgress {
  stage: string;
  message: string;
  percent: number;
}

const storageRoot = process.env.STORAGE_ROOT ?? "./data";
const storage = new LocalDiskStorage(storageRoot);
const ytDlpPath = process.env.YTDLP_PATH ?? "/opt/whisper-venv/bin/yt-dlp";
const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe";
const maxDurationSeconds = Number(process.env.MAX_VIDEO_DURATION_SECONDS ?? 3600);
const maxSizeBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 2_147_483_648);
const minFreeDiskBytes = Number(process.env.MIN_FREE_DISK_BYTES ?? 268_435_456);
const formatSelector = "bestvideo[height<=1080]+bestaudio/best[height<=1080]";

export async function importVideo(input: ImportInput, updateProgress: (progress: ImportProgress) => Promise<void>) {
  const { userId, videoId, databaseJobId, attemptNumber } = input;
  const video = await WorkerVideoModel.findOne({ _id: videoId, userId, source: "url" });
  if (!video || !video.sourceUrl) throw new Error("The video import record no longer exists");
  const sourceUrl = validateYouTubeUrl(input.sourceUrl);
  const workRoot = join(storageRoot, "users", userId, "tmp", "jobs");
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const workDirectory = await mkdtemp(join(workRoot, `import-${videoId}-`));
  const finalPath = storage.pathFor(userId, video.storageKey);

  const publish = async (progress: ImportProgress) => {
    await WorkerJobModel.updateOne({ _id: databaseJobId }, { $set: { status: "processing", progress } });
    await updateProgress(progress);
  };

  try {
    await WorkerJobModel.updateOne(
      { _id: databaseJobId },
      {
        $set: {
          status: "processing",
          attemptsMade: attemptNumber,
          startedAt: new Date(),
          progress: { stage: "metadata", message: "Checking current video metadata and limits", percent: 2 }
        },
        $unset: { failedReason: 1 }
      }
    );

    const metadata = parseYtDlpMetadata(await fetchYtDlpMetadata(sourceUrl, ytDlpPath));
    if (metadata.id !== new URL(sourceUrl).searchParams.get("v")) {
      throw new Error("YouTube returned metadata for a different video link.");
    }
    enforceUrlImportLimits(metadata, maxDurationSeconds, maxSizeBytes);
    const disk = await statfs(storageRoot);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    if (availableBytes < metadata.estimatedSizeBytes + minFreeDiskBytes) {
      throw new Error("Insufficient disk space for this video download and the configured free-space reserve.");
    }

    const existing = await stat(finalPath).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      await verifyImportedMedia(finalPath, metadata.durationSeconds);
      await completeImport(databaseJobId, videoId, userId, existing.size, metadata);
      await updateProgress({ stage: "complete", message: "Video import already completed", percent: 100 });
      return;
    }

    await publish({ stage: "download", message: "Downloading video with yt-dlp", percent: 3 });
    const outputTemplate = join(workDirectory, "source.%(ext)s");
    let outputBuffer = "";
    let progressChain = Promise.resolve();
    await executeYtDlp(ytDlpPath, [
      "--no-playlist",
      "--no-warnings",
      "--no-call-home",
      "--newline",
      "--progress-template",
      "download:CLIPFORGE_PROGRESS:%(progress._percent)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.eta)s",
      "--format",
      formatSelector,
      "--max-filesize",
      String(maxSizeBytes),
      "--merge-output-format",
      "mp4",
      "--remux-video",
      "mp4",
      "--output",
      outputTemplate,
      sourceUrl
    ], (text) => {
      outputBuffer = `${outputBuffer}${text}`;
      const lines = outputBuffer.split(/\r?\n/);
      outputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const progress = parseDownloadProgress(line);
        if (progress) {
          progressChain = progressChain.then(() => publish({
            stage: "download",
            message: `Downloading video · ${progress.percent}%`,
            percent: Math.min(93, 3 + Math.round(progress.percent * 0.9))
          }));
        }
      }
    }, (executable, args) => spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] }));
    await progressChain;

    const outputFiles = await readdir(workDirectory);
    const downloadedName = outputFiles.find((name) => name.startsWith("source.") && name.toLowerCase().endsWith(".mp4"));
    if (!downloadedName) throw new Error("yt-dlp finished without producing an MP4 video.");
    const downloadedPath = join(workDirectory, basename(downloadedName));
    const file = await stat(downloadedPath);
    if (file.size < 1 || file.size > maxSizeBytes) {
      throw new Error(`Downloaded video size exceeds the configured ${maxSizeBytes}-byte limit. Please upload a smaller file.`);
    }
    await verifyImportedMedia(downloadedPath, metadata.durationSeconds);
    await publish({ stage: "verify", message: "Validating downloaded video streams", percent: 96 });
    await storage.move(userId, `tmp/jobs/${basename(workDirectory)}/${downloadedName}`, video.storageKey);
    await completeImport(databaseJobId, videoId, userId, file.size, metadata);
    await updateProgress({ stage: "complete", message: "Video imported and ready for analysis", percent: 100 });
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function verifyImportedMedia(filePath: string, expectedDurationSeconds: number) {
  const media = await probeMediaFile(filePath, ffprobePath);
  enforceDurationLimit(media.durationSeconds, maxDurationSeconds);
  if (Math.abs(media.durationSeconds - expectedDurationSeconds) > Math.max(10, expectedDurationSeconds * 0.05)) {
    throw new Error("The downloaded video duration did not match its metadata.");
  }
  if (!media.hasVideo || !media.hasAudio) {
    throw new Error("The downloaded video must contain both video and audio streams.");
  }
  return media;
}

function parseDownloadProgress(line: string) {
  const match = /^CLIPFORGE_PROGRESS:([\d.]+)\|/.exec(line.trim());
  if (!match) return undefined;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? { percent: Math.max(0, Math.min(100, Math.round(percent))) } : undefined;
}

async function completeImport(databaseJobId: string, videoId: string, userId: string, sizeBytes: number, metadata: ReturnType<typeof parseYtDlpMetadata>) {
  const media = await probeMediaFile(storage.pathFor(userId, `videos/${videoId}.mp4`), ffprobePath);
  enforceDurationLimit(media.durationSeconds, maxDurationSeconds);
  if (!media.hasAudio || !media.hasVideo) throw new Error("The imported media must contain both video and audio streams.");
  await WorkerVideoModel.updateOne(
    { _id: videoId, userId },
    {
      $set: {
        sourceTitle: metadata.title,
        channel: metadata.channel,
        sizeBytes,
        durationSeconds: media.durationSeconds,
        hasAudio: media.hasAudio,
        hasVideo: media.hasVideo,
        status: "uploaded"
      },
      $unset: { analysisError: 1 }
    }
  );
  const previous = await WorkerJobModel.findOneAndUpdate(
    { _id: databaseJobId, status: { $nin: ["completed", "failed"] } },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        progress: { stage: "complete", message: "Video import complete", percent: 100 }
      },
      $unset: { failedReason: 1 }
    },
    { new: false }
  );
  if (previous) {
    await WorkerUserModel.updateOne({ _id: userId, activeAnalysisJobs: { $gt: 0 } }, { $inc: { activeAnalysisJobs: -1 } });
  }
}
