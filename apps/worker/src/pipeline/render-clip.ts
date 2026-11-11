import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { LocalDiskStorage } from "@clipforge/shared/storage";
import { parseTranscriptWords } from "@clipforge/shared/clip-trim";
import type { CaptionStyle } from "@clipforge/shared/caption-config";
import { WorkerClipModel, WorkerJobModel, WorkerTranscriptModel, WorkerVideoModel } from "../models.js";
import { generateAssSubtitles, getCaptionPreviewRange } from "../render/captions.js";
import { buildFfmpegRenderCommand, type ReframeStrategyId } from "../render/ffmpeg-command.js";
import { runFfmpegRender, type RenderProgress } from "../render/run-ffmpeg.js";

const execFileAsync = promisify(execFile);
const storageRoot = resolve(process.env.STORAGE_ROOT ?? "./data");
const storage = new LocalDiskStorage(storageRoot);
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe";
const reserveBytes = Number(process.env.MIN_FREE_DISK_BYTES ?? 268_435_456);
const OUTPUT_SETTINGS = {
  width: 1080 as const,
  height: 1920 as const,
  videoCodec: "libx264" as const,
  preset: "veryfast" as const,
  crf: 23 as const,
  threads: 2 as const,
  audioCodec: "aac" as const,
  pixelFormat: "yuv420p" as const,
  faststart: true as const
};

interface RenderClipInput {
  userId: string;
  videoId: string;
  clipId: string;
  databaseJobId: string;
  attemptNumber: number;
  reframeStrategy: ReframeStrategyId;
  captionStyle?: CaptionStyle;
  cleanupCaptionFillers?: boolean;
  previewOnly?: boolean;
  previewId?: string;
}

interface RenderClipProgress extends RenderProgress {
  stage: string;
}

async function verifyRenderedOutput(path: string, expectsAudio: boolean) {
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height",
    "-of", "json",
    path
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  if (!video || video.width !== 1080 || video.height !== 1920 || video.codec_name !== "h264") {
    throw new Error("ffmpeg output validation failed: expected a 1080x1920 H.264 video");
  }
  if (expectsAudio && !parsed.streams?.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac")) {
    throw new Error("ffmpeg output validation failed: expected an AAC audio stream");
  }
}

export async function renderClip(
  input: RenderClipInput,
  updateProgress: (progress: RenderClipProgress) => Promise<void>
) {
  const {
    userId, videoId, clipId, databaseJobId, attemptNumber, reframeStrategy,
    captionStyle, cleanupCaptionFillers, previewOnly = false, previewId
  } = input;
  const [clip, video, transcript] = await Promise.all([
    WorkerClipModel.findOne({ _id: clipId, videoId }),
    WorkerVideoModel.findOne({ _id: videoId, userId }),
    WorkerTranscriptModel.findOne({ videoId })
  ]);
  if (!clip) throw new Error("The clip selected for rendering no longer exists");
  if (!video) throw new Error("The source video for this clip no longer exists");
  if (!previewOnly && !clip.selectedForRendering) throw new Error("Select this clip for rendering before starting a render");
  if (previewOnly && !previewId) throw new Error("The caption preview job is missing its preview ID");
  if (!video.hasVideo) throw new Error("The source video has no video stream");
  if (typeof video.durationSeconds !== "number" || clip.start < 0 || clip.end <= clip.start || clip.end > video.durationSeconds) {
    throw new Error("The clip trim is outside the source video's duration");
  }
  if (!transcript) throw new Error("The saved word-level transcript is unavailable for captions");

  const publish = async (progress: RenderClipProgress) => {
    await Promise.all([
      ...(!previewOnly ? [WorkerClipModel.updateOne({ _id: clipId, videoId }, {
        $set: { renderStatus: "rendering", renderProgress: progress }
      })] : []),
      WorkerJobModel.updateOne({ _id: databaseJobId }, {
        $set: {
          status: "processing",
          attemptsMade: attemptNumber,
          startedAt: new Date(),
          progress
        },
        $unset: { failedReason: 1 }
      }),
      updateProgress(progress)
    ]);
  };

  const effectiveCaptionStyle = captionStyle ?? clip.captionStyle ?? "clean";
  const effectiveCleanupFillers = cleanupCaptionFillers ?? clip.cleanupCaptionFillers ?? true;
  const renderSettings = {
    ...OUTPUT_SETTINGS,
    reframeStrategy,
    captionStyle: effectiveCaptionStyle,
    cleanupCaptionFillers: effectiveCleanupFillers
  };
  const outputKey = previewOnly ? `tmp/previews/${previewId}.mp4` : `clips/${clipId}.mp4`;
  const { start: renderStart, end: renderEnd } = previewOnly
    ? getCaptionPreviewRange(clip.start, clip.end)
    : { start: clip.start, end: clip.end };
  if (!previewOnly && clip.renderStatus === "ready" && clip.renderFilePath === outputKey &&
    clip.renderSettings?.reframeStrategy === reframeStrategy &&
    clip.renderSettings?.captionStyle === effectiveCaptionStyle &&
    clip.renderSettings?.cleanupCaptionFillers === effectiveCleanupFillers) {
    try {
      const currentOutput = await stat(storage.pathFor(userId, outputKey));
      if (currentOutput.size > 0) {
        await WorkerJobModel.updateOne({ _id: databaseJobId }, {
          $set: {
            status: "completed",
            completedAt: new Date(),
            progress: { stage: "complete", message: "This clip already has a matching render", percent: 100, etaSeconds: 0 }
          }
        });
        return;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (!previewOnly) {
    await WorkerClipModel.updateOne({ _id: clipId, videoId }, {
      $set: { renderSettings, renderStatus: "rendering" },
      $unset: { renderError: 1 }
    });
  }

  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const disk = await statfs(storageRoot);
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  const renderDuration = renderEnd - renderStart;
  const estimatedOutputBytes = Math.max(8 * 1024 * 1024, renderDuration * 1_000_000);
  if (availableBytes < reserveBytes + estimatedOutputBytes) {
    throw new Error(
      `Insufficient disk space to render this clip: ${(availableBytes / 1024 ** 2).toFixed(0)} MiB available; ` +
      `${((reserveBytes + estimatedOutputBytes) / 1024 ** 2).toFixed(0)} MiB required including the configured reserve.`
    );
  }

  const workRoot = join(storageRoot, "users", userId, "tmp", "jobs");
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const workDirectory = await mkdtemp(join(workRoot, `render-${clipId}-`));
  const assPath = join(workDirectory, "captions.ass");
  const outputPath = join(workDirectory, `${clipId}.mp4`);
  const outputTempKey = `tmp/jobs/${basename(workDirectory)}/${clipId}.mp4`;
  const outputPathForStorage = storage.pathFor(userId, outputTempKey);
  let outputMoved = false;

  try {
    const transcriptFile = JSON.parse(await readFile(storage.pathFor(userId, transcript.wordsPath), "utf8")) as {
      words?: unknown;
    };
    if (!Array.isArray(transcriptFile.words)) throw new Error("The word-level transcript has an invalid format");
    const { words, skippedZeroDurationWords } = parseTranscriptWords(transcriptFile.words);
    if (skippedZeroDurationWords > 0) {
      console.warn(JSON.stringify({
        level: "warn",
        event: "render.transcript.zero_duration_words.skipped",
        videoId,
        clipId,
        count: skippedZeroDurationWords
      }));
    }
    const captionWords = words.filter((word) => word.start >= renderStart && word.end <= renderEnd);
    if (captionWords.length === 0) throw new Error("No word timestamps overlap this clip for caption generation");
    await writeFile(
      assPath,
      generateAssSubtitles(captionWords, renderStart, renderEnd, effectiveCaptionStyle, effectiveCleanupFillers),
      { mode: 0o600 }
    );

    await publish({
      stage: "render",
      message: previewOnly
        ? `Rendering 5-second ${effectiveCaptionStyle} caption preview`
        : `Rendering 9:16 clip with ${reframeStrategy} reframing`,
      percent: 0,
      etaSeconds: Math.ceil(renderDuration * 3)
    });
    const command = buildFfmpegRenderCommand(
      storage.pathFor(userId, video.storageKey),
      assPath,
      outputPath,
      renderStart,
      renderEnd,
      reframeStrategy,
      video.hasAudio
    );
    await runFfmpegRender(ffmpegPath, command, renderDuration, async (progress) => {
      await publish({ ...progress, stage: "render" });
    });
    const output = await stat(outputPathForStorage);
    if (output.size <= 0) throw new Error("ffmpeg did not create a render file");
    await verifyRenderedOutput(outputPath, video.hasAudio);
    await storage.move(userId, outputTempKey, outputKey);
    outputMoved = true;

    const renderedAt = new Date();
    const finalProgress = {
      stage: "complete",
      message: previewOnly ? "5-second caption preview ready" : "Render ready",
      percent: 100,
      etaSeconds: 0
    };
    const previousPreviewPath = previewOnly ? clip.captionPreviewFilePath : undefined;
    if (previewOnly) {
      await WorkerClipModel.updateOne({ _id: clipId, videoId }, { $set: { captionPreviewFilePath: outputKey } });
      await WorkerJobModel.updateOne({ _id: databaseJobId, status: { $nin: ["completed", "failed"] } }, {
        $set: { status: "completed", completedAt: renderedAt, progress: finalProgress },
        $unset: { failedReason: 1 }
      });
    } else {
      await Promise.all([
        WorkerClipModel.updateOne({ _id: clipId, videoId }, {
        $set: {
          renderStatus: "ready",
          renderFilePath: outputKey,
          renderSettings,
          renderedAt,
          renderProgress: finalProgress
        },
        $unset: { renderError: 1 }
        }),
        WorkerJobModel.updateOne({ _id: databaseJobId, status: { $nin: ["completed", "failed"] } }, {
          $set: { status: "completed", completedAt: renderedAt, progress: finalProgress },
          $unset: { failedReason: 1 }
        })
      ]);
    }
    if (previousPreviewPath && previousPreviewPath !== outputKey) {
      await storage.delete(userId, previousPreviewPath);
    }
  } catch (error) {
    await storage.delete(userId, outputTempKey);
    if (previewOnly && outputMoved) {
      await storage.delete(userId, outputKey);
      await WorkerClipModel.updateOne(
        { _id: clipId, videoId, captionPreviewFilePath: outputKey },
        { $unset: { captionPreviewFilePath: 1 } }
      );
    }
    throw error;
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}
