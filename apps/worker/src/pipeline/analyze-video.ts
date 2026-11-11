import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StorageProvider } from "@clipforge/shared/storage";
import type { ClipTopicSegment } from "@clipforge/shared/clip-topics";
import { LocalDiskStorage } from "@clipforge/shared/storage";
import { probeMediaFile, enforceDurationLimit } from "@clipforge/shared/media-probe";
import { extractMonoPcmAudio } from "../media/commands.js";
import {
  WorkerAnalysisModel,
  WorkerClipModel,
  WorkerClipMetadataModel,
  WorkerJobModel,
  WorkerTranscriptModel,
  WorkerUserModel,
  WorkerVideoModel
} from "../models.js";
import { buildTranscriptSentences } from "../clips/shortlist.js";
import { segmentTopicsWithFallback } from "../clips/topics.js";
import { FastEmbedEmbeddingProvider } from "../clips/embeddings.js";
import { transcribeAudio } from "../transcription/runner.js";
import { HeuristicVideoTypeDetector, type VideoTypeResult } from "../video-type/detector.js";

interface PipelineProgress {
  stage: string;
  message: string;
  percent: number;
  completedChunks?: number;
  totalChunks?: number;
  etaSeconds?: number;
}

interface PipelineInput {
  userId: string;
  videoId: string;
  databaseJobId: string;
  queueJobId: string;
  attemptNumber: number;
  clipId?: string;
  modelSpeed?: "fast" | "balanced";
}

const storageRoot = process.env.STORAGE_ROOT ?? "./data";
const storage: StorageProvider = new LocalDiskStorage(storageRoot);
const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe";
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const configuredModelSize = process.env.WHISPER_MODEL_SIZE ?? "base";
const chunkSeconds = Number(process.env.WHISPER_CHUNK_SECONDS ?? 30);
const maxDurationSeconds = Number(process.env.MAX_VIDEO_DURATION_SECONDS ?? 3600);
const whisperVenv = process.env.WHISPER_VENV ?? "/opt/whisper-venv";
const whisperPython = join(whisperVenv, "bin", "python");
const whisperModelDir = process.env.WHISPER_MODEL_DIR ?? "/models";
const detector = new HeuristicVideoTypeDetector();

export async function analyzeVideo(input: PipelineInput, updateProgress: (progress: PipelineProgress) => Promise<void>) {
  const { userId, videoId, databaseJobId, queueJobId, attemptNumber } = input;
  const modelSize = input.modelSpeed === "fast" ? "base"
    : input.modelSpeed === "balanced" ? "small"
      : configuredModelSize;
  const video = await WorkerVideoModel.findOne({ _id: videoId, userId });
  if (!video) throw new Error("The video for this analysis job no longer exists");
  if (typeof video.durationSeconds !== "number") throw new Error("The video duration was not recorded at upload time");
  enforceDurationLimit(video.durationSeconds, maxDurationSeconds);

  const jobDirectory = resolve(storageRoot, "users", userId, "tmp", "jobs", `${videoId}-${randomUUID()}-`);
  await mkdir(join(storageRoot, "users", userId, "tmp", "jobs"), { recursive: true, mode: 0o700 });
  const workDirectory = await mkdtemp(jobDirectory);
  const transcriptPath = `transcripts/${videoId}.words.json`;
  const startedAt = new Date();

  const publish = async (progress: PipelineProgress) => {
    await WorkerJobModel.updateOne({ _id: databaseJobId }, { $set: { progress, status: "processing" } });
    await updateProgress(progress);
  };

  try {
    await WorkerJobModel.updateOne(
      { _id: databaseJobId },
      {
        $set: {
          status: "processing",
          attemptsMade: attemptNumber,
          startedAt,
          progress: { stage: "ingest", message: "Preparing source media", percent: 2 }
        },
        $unset: { failedReason: 1 }
      }
    );
    await WorkerVideoModel.updateOne({ _id: videoId, userId }, { $set: { status: "processing" }, $unset: { analysisError: 1 } });
    const existingTranscript = await WorkerTranscriptModel.findOne({ videoId });
    const existingAnalysis = await WorkerAnalysisModel.findOne({ videoId }).lean();
    if (existingTranscript && existingAnalysis) {
      await publish({ stage: "complete", message: "Analysis already exists", percent: 100 });
      await completeJob(databaseJobId, videoId, userId);
      return;
    }

    let segments = existingTranscript?.segments ?? [];
    let language = existingTranscript?.language ?? "und";
    let wordCount = existingTranscript?.wordCount ?? 0;
    let transcriptWords = [] as Array<{ text: string; start: number; end: number; probability?: number }>;
    if (!existingTranscript) {
      const sourcePath = join(workDirectory, "source-media");
      const audioPath = join(workDirectory, "audio-16khz-mono.wav");
      const transcriptOutputPath = join(workDirectory, "transcript.json");
      await publish({ stage: "ingest", message: "Reading source video from local storage", percent: 4 });
      await pipeline(storage.createReadStream(userId, video.storageKey), createWriteStream(sourcePath, { mode: 0o600 }));

      const media = await probeMediaFile(sourcePath, ffprobePath);
      enforceDurationLimit(media.durationSeconds, maxDurationSeconds);
      if (!media.hasAudio) throw new Error("The source video has no audio stream to transcribe");

      await publish({ stage: "extract-audio", message: "Extracting mono 16 kHz audio", percent: 8 });
      await extractMonoPcmAudio(ffmpegPath, sourcePath, audioPath);
      await publish({
        stage: "transcribe",
        message: `Loading Whisper ${modelSize}; the ETA will improve after the first audio chunk`,
        percent: 10,
        etaSeconds: Math.ceil(media.durationSeconds * 2)
      });

      const transcript = await transcribeAudio(audioPath, transcriptOutputPath, {
        model: modelSize,
        chunkSeconds,
        modelDirectory: whisperModelDir,
        pythonPath: whisperPython,
        onProgress: async (progress) => {
          const fraction = progress.totalChunks > 0 ? progress.completedChunks / progress.totalChunks : 0;
          await publish({
            stage: "transcribe",
            message: progress.message,
            percent: Math.min(88, 10 + Math.round(fraction * 78)),
            completedChunks: progress.completedChunks,
            totalChunks: progress.totalChunks,
            ...(progress.etaSeconds !== undefined ? { etaSeconds: progress.etaSeconds } : {})
          });
        }
      });
      segments = transcript.segments;
      language = transcript.language;
      wordCount = transcript.words.length;
      transcriptWords = transcript.words;
      const wordsJson = JSON.stringify({
        language,
        languageChunks: transcript.languageChunks,
        model: modelSize,
        words: transcript.words
      });
      await storage.delete(userId, transcriptPath);
      await pipeline(Readable.from([wordsJson]), await storage.createWriteStream(userId, transcriptPath));
      await WorkerTranscriptModel.findOneAndUpdate(
        { videoId },
        {
          $set: {
            language,
            model: modelSize,
            wordCount,
            segmentCount: transcript.segments.length,
            wordsPath: transcriptPath,
            segments: transcript.segments
          },
          $setOnInsert: { videoId }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } else {
      await publish({ stage: "transcribe", message: "Reusing the saved transcript", percent: 88 });
      const savedWordsPath = (storage as LocalDiskStorage).pathFor(userId, existingTranscript.wordsPath);
      const savedWordsRaw = await readFile(savedWordsPath, "utf8");
      const savedWordsPayload = JSON.parse(savedWordsRaw) as { words?: Array<{ text: string; start: number; end: number; probability?: number }> };
      transcriptWords = Array.isArray(savedWordsPayload.words) ? savedWordsPayload.words : [];
    }

    await publish({ stage: "classify", message: "Classifying video type from transcript cues", percent: 93 });
    const sentenceRanges = buildTranscriptSentences(transcriptWords);
    let topicSegments = existingAnalysis?.topicSegments ?? [];
    let topicsMode: "semantic" | "basic" = existingAnalysis?.topicsMode === "basic" ? "basic" : "semantic";
    let topicWarning: string | undefined = existingAnalysis?.topicWarning ?? undefined;
    if (sentenceRanges.length > 0) {
      const embeddingProvider = new FastEmbedEmbeddingProvider();
      try {
        const outcome = await segmentTopicsWithFallback(
          sentenceRanges,
          () => embeddingProvider.embedSentences(sentenceRanges.map((sentence) => sentence.text))
        );
        topicSegments = outcome.topics;
        topicsMode = outcome.mode;
        topicWarning = outcome.warning;
        if (outcome.embeddingError) {
          console.warn(JSON.stringify({
            level: "warn",
            event: "analysis.topic.embedding_failed",
            videoId,
            userId,
            message: outcome.embeddingError,
            fallback: "basic-heuristic"
          }));
        }
      } finally {
        await embeddingProvider.release();
      }
    }
    const analysis = existingAnalysis;
    const classification: VideoTypeResult = analysis
      ? {
          type: analysis.videoType,
          speechDensityWordsPerMinute: analysis.heuristics.speechDensityWordsPerMinute,
          questionRatio: analysis.heuristics.questionRatio,
          meanPauseSeconds: analysis.heuristics.meanPauseSeconds,
          cueCounts: analysis.heuristics.cueCounts
        }
      : detector.detect({ segments, durationSeconds: video.durationSeconds });
    await WorkerAnalysisModel.findOneAndUpdate(
      { videoId },
      {
        $set: {
          videoType: classification.type,
          topicSegments,
          topicsMode,
          topicWarning,
          heuristics: {
            speechDensityWordsPerMinute: classification.speechDensityWordsPerMinute,
            questionRatio: classification.questionRatio,
            meanPauseSeconds: classification.meanPauseSeconds,
            cueCounts: classification.cueCounts
          }
        },
        $setOnInsert: { videoId }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await WorkerVideoModel.updateOne(
      { _id: videoId, userId },
      { $set: { status: "ready", detectedType: classification.type }, $unset: { analysisError: 1 } }
    );
    await publish({ stage: "complete", message: `Transcript ready · ${wordCount} words · ${classification.type}`, percent: 100 });
    await completeJob(databaseJobId, videoId, userId);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function completeJob(databaseJobId: string, videoId: string, userId: string) {
  const previous = await WorkerJobModel.findOneAndUpdate(
    { _id: databaseJobId, status: { $nin: ["completed", "failed"] } },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        progress: { stage: "complete", message: "Analysis complete", percent: 100 }
      },
      $unset: { failedReason: 1 }
    },
    { new: false }
  );
  if (previous) {
    await WorkerUserModel.updateOne({ _id: userId, activeAnalysisJobs: { $gt: 0 } }, { $inc: { activeAnalysisJobs: -1 } });
  }
  await WorkerVideoModel.updateOne({ _id: videoId, userId }, { $set: { status: "ready" } });
}

export async function recomputeTopics(
  input: PipelineInput,
  updateProgress: (progress: PipelineProgress) => Promise<void>
) {
  const { userId, videoId, databaseJobId } = input;
  const video = await WorkerVideoModel.findOne({ _id: videoId, userId });
  if (!video) throw new Error("The video for this topic recompute job no longer exists");

  const transcript = await WorkerTranscriptModel.findOne({ videoId });
  if (!transcript) throw new Error("The saved transcript is not available for topic recomputation");

  const savedWordsPath = (storage as LocalDiskStorage).pathFor(userId, transcript.wordsPath);
  const savedWordsRaw = await readFile(savedWordsPath, "utf8");
  const savedWordsPayload = JSON.parse(savedWordsRaw) as {
    words?: Array<{ text: string; start: number; end: number; probability?: number }>;
  };
  const transcriptWords = Array.isArray(savedWordsPayload.words) ? savedWordsPayload.words : [];
  if (transcriptWords.length === 0) throw new Error("The saved transcript contains no words to segment");

  const sentenceRanges = buildTranscriptSentences(transcriptWords);
  const job = await WorkerJobModel.findById(databaseJobId);
  const publish = async (progress: PipelineProgress) => {
    await WorkerJobModel.updateOne({ _id: databaseJobId }, { $set: { progress, status: "processing" } });
    await updateProgress(progress);
  };

  await publish({ stage: "topics", message: "Rebuilding topic boundaries from the saved transcript", percent: 10 });
  const embeddingProvider = new FastEmbedEmbeddingProvider();
  let topicsMode: "semantic" | "basic" = "semantic";
  let topicWarning: string | undefined;
  let topicSegments: ClipTopicSegment[] = [];
  try {
    const outcome = await segmentTopicsWithFallback(sentenceRanges, () =>
      embeddingProvider.embedSentences(sentenceRanges.map((sentence) => sentence.text), {
        onProgress: async (progress) => {
          await publish({
            stage: "topics",
            message: `Embedding transcript sentences (${progress.completed}/${progress.total})`,
            percent: Math.min(80, 10 + Math.round((progress.completed / Math.max(1, progress.total)) * 70))
          });
        }
      })
    );
    topicsMode = outcome.mode;
    topicWarning = outcome.warning;
    topicSegments = outcome.topics;
    if (outcome.embeddingError) {
      console.warn(JSON.stringify({
        level: "warn",
        event: "analysis.topics.recompute.embedding_failed",
        videoId,
        userId,
        message: outcome.embeddingError,
        fallback: "basic-heuristic"
      }));
    }
  } finally {
    await embeddingProvider.release();
  }

  await WorkerAnalysisModel.findOneAndUpdate(
    { videoId },
    {
      $set: {
        topicSegments,
        topicsMode,
        topicWarning,
        updatedAt: new Date()
      }
    },
    { upsert: true, new: true }
  );
  await publish({ stage: "complete", message: topicWarning ? "Topic boundaries refreshed in basic mode" : "Topic boundaries refreshed", percent: 100 });
  await completeJob(databaseJobId, videoId, userId);

  if (job && job.type === "recompute-topics") {
    await WorkerVideoModel.updateOne({ _id: videoId, userId }, { $set: { status: "ready" } });
  }
}

export async function recordJobFailure(input: PipelineInput, error: unknown) {
  const { databaseJobId, videoId, userId, attemptNumber, clipId } = input;
  const message = (error instanceof Error ? error.message : "Unknown analysis error").slice(0, 1000);
  const job = await WorkerJobModel.findById(databaseJobId);
  if (!job) return;
  const isFinalAttempt = attemptNumber >= job.maxAttempts;
  const nextStatus = isFinalAttempt ? "failed" : "retrying";
  const previous = await WorkerJobModel.findOneAndUpdate(
    { _id: databaseJobId, status: { $nin: ["completed", "failed"] } },
    {
      $set: {
        status: nextStatus,
        attemptsMade: attemptNumber,
        failedReason: message,
        progress: {
          stage: isFinalAttempt ? "failed" : "retrying",
          message: isFinalAttempt ? message : `Attempt ${attemptNumber} failed; retrying automatically`,
          percent: 0
        },
        ...(isFinalAttempt ? { completedAt: new Date() } : {})
      }
    },
    { new: false }
  );
  if (previous && isFinalAttempt) {
    if (job.type === "render" && clipId && !job.captionPreview) {
      await WorkerClipModel.updateOne(
        { _id: clipId, videoId },
        { $set: { renderStatus: "failed", renderError: message, renderProgress: { message, percent: 0 } } }
      );
    } else if (job.type === "metadata" && clipId) {
      await WorkerClipMetadataModel.updateOne(
        { clipId, videoId },
        {
          $set: {
            generationStatus: "failed",
            generationError: message,
            generationProgress: { message, percent: 0 }
          }
        }
      );
    } else if (job.type !== "find-clips" && job.type !== "render") {
      await WorkerVideoModel.updateOne({ _id: videoId, userId }, { $set: { status: "failed", analysisError: message } });
    }
    if (job.type !== "render" && job.type !== "metadata") {
      await WorkerUserModel.updateOne({ _id: userId, activeAnalysisJobs: { $gt: 0 } }, { $inc: { activeAnalysisJobs: -1 } });
    }
  } else if (previous && job.type === "render" && clipId && !job.captionPreview) {
    await WorkerClipModel.updateOne(
      { _id: clipId, videoId },
      { $set: { renderStatus: "rendering", renderError: `Attempt ${attemptNumber} failed; retrying automatically` } }
    );
  } else if (previous && job.type === "metadata" && clipId) {
    await WorkerClipMetadataModel.updateOne(
      { clipId, videoId },
      {
        $set: {
          generationStatus: isFinalAttempt ? "failed" : "retrying",
          generationError: message,
          generationProgress: {
            message: isFinalAttempt ? message : `Attempt ${attemptNumber} failed; retrying automatically`,
            percent: 0
          }
        }
      }
    );
  }
}

export async function cleanupStaleWorkerDirectories(olderThan: Date) {
  const usersRoot = resolve(storageRoot, "users");
  let users;
  try {
    users = await (await import("node:fs/promises")).readdir(usersRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw error;
  }
  let cleaned = 0;
  for (const user of users) {
    if (!user.isDirectory() || !/^[a-f\d]{24}$/i.test(user.name)) continue;
    const jobsRoot = join(usersRoot, user.name, "tmp", "jobs");
    let directories;
    try {
      directories = await (await import("node:fs/promises")).readdir(jobsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const path = join(jobsRoot, directory.name);
      const details = await (await import("node:fs/promises")).stat(path);
      if (details.mtime < olderThan) {
        await rm(path, { recursive: true, force: true });
        cleaned += 1;
      }
    }
    const previewsRoot = join(usersRoot, user.name, "tmp", "previews");
    let previews;
    try {
      previews = await (await import("node:fs/promises")).readdir(previewsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    for (const preview of previews) {
      if (!preview.isFile() || !/^[a-f\d-]{36}\.mp4$/i.test(preview.name)) continue;
      const path = join(previewsRoot, preview.name);
      const details = await (await import("node:fs/promises")).stat(path);
      if (details.mtime < olderThan) {
        await rm(path, { force: true });
        cleaned += 1;
      }
    }
  }
  return cleaned;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
