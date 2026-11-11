import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";
import type { MetadataOptions } from "@clipforge/shared/clip-metadata";

interface VideoJobBase {
  userId: string;
  videoId: string;
  databaseJobId: string;
}

export interface AnalysisJobData extends VideoJobBase {
  type: "analysis";
  modelSpeed: "fast" | "balanced";
}

export interface UrlImportJobData extends VideoJobBase {
  type: "url-import";
  sourceUrl: string;
}

export interface FindClipsJobData extends VideoJobBase {
  type: "find-clips";
  useGemini?: boolean;
}

export interface RenderJobData extends VideoJobBase {
  type: "render";
  clipId: string;
  reframeStrategy: "blur-fit" | "center-crop";
  captionStyle?: "clean" | "karaoke" | "bold-pop";
  cleanupCaptionFillers?: boolean;
  captionPreview?: boolean;
  previewId?: string;
}

export interface MetadataJobData extends VideoJobBase {
  type: "metadata";
  clipId: string;
  options: MetadataOptions;
}

export interface RecomputeTopicsJobData extends VideoJobBase {
  type: "recompute-topics";
}

export type VideoJobData = AnalysisJobData | UrlImportJobData | FindClipsJobData | RenderJobData | MetadataJobData | RecomputeTopicsJobData;

const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export const analysisQueue = new Queue<VideoJobData>("video-analysis", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: false,
    removeOnFail: false
  }
});

export async function closeAnalysisQueue() {
  await analysisQueue.close();
  await connection.quit();
}
