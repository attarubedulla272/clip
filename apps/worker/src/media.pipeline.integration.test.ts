import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import mongoose, { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { enforceDurationLimit, MediaProbeError, probeMediaFile } from "@clipforge/shared/media-probe";
import { LocalDiskStorage } from "@clipforge/shared/storage";
import {
  WorkerAnalysisModel,
  WorkerJobModel,
  WorkerTranscriptModel,
  WorkerUserModel,
  WorkerVideoModel
} from "./models.js";
import { analyzeVideo } from "./pipeline/analyze-video.js";

const enabled = process.env.RUN_MEDIA_INTEGRATION === "true";
const execFileAsync = promisify(execFile);
const storageRoot = process.env.STORAGE_ROOT ?? "./data";

describe.skipIf(!enabled)("local media pipeline integration", () => {
  it("rejects fake media and runs a two-minute video through the analysis pipeline", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clipforge-media-integration-"));
    const userId = new Types.ObjectId();
    const videoId = new Types.ObjectId();
    const databaseJobId = new Types.ObjectId();
    const projectId = new Types.ObjectId();
    const storage = new LocalDiskStorage(storageRoot);
    const sourceKey = `videos/integration-${randomUUID()}.mp4`;
    const wordsKey = `transcripts/${videoId}.words.json`;
    let connected = false;

    try {
      await mongoose.connect(process.env.MONGO_URI ?? "mongodb://localhost:27017/clipforge");
      connected = true;

      const fakePath = join(workspace, "fake.mp4");
      await writeFile(fakePath, "not a media file");
      await expect(
        probeMediaFile(fakePath, process.env.FFPROBE_PATH ?? "ffprobe")
      ).rejects.toBeInstanceOf(MediaProbeError);

      const speechPath = join(workspace, "speech.wav");
      const samplePath = join(workspace, "sample-2min.mp4");
      const pythonText = [
        "Today we are building a small creative project together.",
        "First, open the workspace and make a new video.",
        "Next, listen carefully and notice how each idea connects.",
        "What makes a useful explanation clear and easy to follow?",
        "Finally, save your work and share what you learned."
      ].join(" ");

      await execFileAsync("espeak-ng", ["-w", speechPath, "-s", "150", pythonText]);
      await execFileAsync(process.env.FFMPEG_PATH ?? "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=15",
        "-stream_loop", "-1", "-i", speechPath,
        "-t", "120",
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k",
        samplePath
      ]);

      const media = await probeMediaFile(samplePath, process.env.FFPROBE_PATH ?? "ffprobe");
      expect(media.hasAudio).toBe(true);
      expect(media.hasVideo).toBe(true);
      expect(media.durationSeconds).toBeGreaterThanOrEqual(119);
      expect(media.durationSeconds).toBeLessThanOrEqual(121);
      expect(() => enforceDurationLimit(media.durationSeconds, 60)).toThrow(MediaProbeError);

      await pipeline(
        createReadStream(samplePath),
        await storage.createWriteStream(userId.toString(), sourceKey)
      );

      await WorkerUserModel.create({ _id: userId, activeAnalysisJobs: 1 });
      await WorkerVideoModel.create({
        _id: videoId,
        userId,
        projectId,
        storageKey: sourceKey,
        durationSeconds: media.durationSeconds,
        hasAudio: media.hasAudio,
        hasVideo: media.hasVideo,
        status: "queued"
      });
      await WorkerJobModel.create({
        _id: databaseJobId,
        queueJobId: `integration-${randomUUID()}`,
        userId,
        videoId,
        type: "analysis",
        status: "queued",
        progress: { stage: "queued", message: "Waiting for a worker", percent: 0 },
        attemptsMade: 0,
        maxAttempts: 3
      });

      let transcriptionStartedAt: number | undefined;
      let transcriptionFinishedAt: number | undefined;
      const chunkUpdates: Array<{ completedChunks?: number; totalChunks?: number }> = [];
      await analyzeVideo({
        userId: userId.toString(),
        videoId: videoId.toString(),
        databaseJobId: databaseJobId.toString(),
        queueJobId: `integration-${videoId}`,
        attemptNumber: 1
      }, async (progress) => {
        if (progress.stage === "transcribe" && progress.message.startsWith("Loading Whisper")) {
          transcriptionStartedAt = performance.now();
        }
        if (progress.stage === "transcribe" && progress.completedChunks !== undefined) {
          if (progress.totalChunks !== undefined) {
            chunkUpdates.push({ completedChunks: progress.completedChunks, totalChunks: progress.totalChunks });
            if (progress.completedChunks === progress.totalChunks) transcriptionFinishedAt = performance.now();
          }
        }
      });

      if (transcriptionStartedAt === undefined || transcriptionFinishedAt === undefined) {
        throw new Error("The pipeline did not report transcription start and chunk completion");
      }
      const transcriptionSeconds = (transcriptionFinishedAt - transcriptionStartedAt) / 1_000;
      console.log(`CLIPFORGE_SAMPLE_TRANSCRIPTION_SECONDS=${transcriptionSeconds.toFixed(1)}`);
      const [job, video, transcript, analysis, user] = await Promise.all([
        WorkerJobModel.findById(databaseJobId).lean(),
        WorkerVideoModel.findById(videoId).lean(),
        WorkerTranscriptModel.findOne({ videoId }).lean(),
        WorkerAnalysisModel.findOne({ videoId }).lean(),
        WorkerUserModel.findById(userId).lean()
      ]);
      const transcriptFile = JSON.parse(await readFile(resolve(storageRoot, "users", userId.toString(), wordsKey), "utf8")) as {
        words: Array<{ text: string; start: number; end: number }>;
      };

      expect(transcriptionStartedAt).toBeDefined();
      expect(transcriptionFinishedAt).toBeDefined();
      expect(transcriptionSeconds).toBeGreaterThan(0);
      expect(chunkUpdates.length).toBeGreaterThanOrEqual(4);
      expect(chunkUpdates.at(-1)?.completedChunks).toBe(chunkUpdates.at(-1)?.totalChunks);
      expect(job?.status).toBe("completed");
      expect(video?.status).toBe("ready");
      expect(transcript?.wordCount).toBeGreaterThan(0);
      expect(transcript?.segments.length).toBeGreaterThan(0);
      expect(transcriptFile.words.length).toBe(transcript?.wordCount);
      expect(analysis?.videoType).toBeTruthy();
      expect(user?.activeAnalysisJobs).toBe(0);

      await analyzeVideo({
        userId: userId.toString(),
        videoId: videoId.toString(),
        databaseJobId: databaseJobId.toString(),
        queueJobId: `integration-${videoId}`,
        attemptNumber: 2
      }, async () => undefined);
      expect(await WorkerTranscriptModel.countDocuments({ videoId })).toBe(1);
      expect(await WorkerAnalysisModel.countDocuments({ videoId })).toBe(1);
    } finally {
      await storage.delete(userId.toString(), sourceKey);
      await storage.delete(userId.toString(), wordsKey);
      await rm(resolve(storageRoot, "users", userId.toString()), { recursive: true, force: true });
      if (connected) {
        await Promise.all([
          WorkerJobModel.deleteOne({ _id: databaseJobId }),
          WorkerVideoModel.deleteOne({ _id: videoId }),
          WorkerTranscriptModel.deleteOne({ videoId }),
          WorkerAnalysisModel.deleteOne({ videoId }),
          WorkerUserModel.deleteOne({ _id: userId })
        ]);
        await mongoose.disconnect();
      }
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);
});
