import { Schema, model, Types } from "mongoose";
import type { VideoType } from "@clipforge/shared";
import type { TranscriptSegment } from "./transcription/chunks.js";
import type { ClipFactorBreakdown, ClipScoreResult } from "@clipforge/shared/clip-scoring";
import type { ClipMetadataResult, MetadataOptions, TrendSignals } from "@clipforge/shared/clip-metadata";
import type { ClipTopicSegment } from "@clipforge/shared/clip-topics";
import type { ClipFunnelReport } from "@clipforge/shared/clip-funnel";
import type { ClipStandaloneCheck } from "@clipforge/shared/clip-standalone";
import { CAPTION_STYLE_CONFIG, type CaptionStyle } from "@clipforge/shared/caption-config";

export interface WorkerVideo {
  userId: Types.ObjectId;
  projectId: Types.ObjectId;
  source: "upload" | "url";
  originalName: string;
  sourceUrl?: string;
  sourceTitle?: string;
  channel?: string;
  sizeBytes: number;
  storageKey: string;
  durationSeconds?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  status: string;
  detectedType?: VideoType;
  analysisError?: string;
}

const videoSchema = new Schema<WorkerVideo>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
  source: { type: String, enum: ["upload", "url"], required: true, default: "upload" },
  originalName: { type: String, required: true, maxlength: 255 },
  sourceUrl: { type: String, maxlength: 2048 },
  sourceTitle: { type: String, maxlength: 500 },
  channel: { type: String, maxlength: 200 },
  sizeBytes: { type: Number, min: 1, default: 1 },
  storageKey: { type: String, required: true },
  durationSeconds: Number,
  hasAudio: { type: Boolean, required: true },
  hasVideo: { type: Boolean, required: true },
  status: { type: String, enum: ["uploaded", "queued", "processing", "ready", "failed"], required: true },
  detectedType: { type: String, enum: ["podcast", "interview", "tutorial", "vlog", "other"] },
  analysisError: { type: String, maxlength: 1000 }
}, { timestamps: true });

export interface WorkerJobProgress {
  stage: string;
  message: string;
  percent: number;
  completedChunks?: number;
  totalChunks?: number;
  etaSeconds?: number;
}

export interface WorkerJob {
  queueJobId: string;
  type: "analysis" | "url-import" | "find-clips" | "render" | "metadata" | "recompute-topics";
  modelSpeed: "fast" | "balanced";
  useGemini: boolean;
  userId: Types.ObjectId;
  videoId: Types.ObjectId;
  clipId?: Types.ObjectId;
  captionPreview?: boolean;
  status: string;
  progress: WorkerJobProgress;
  attemptsMade: number;
  maxAttempts: number;
  failedReason?: string;
  startedAt?: Date;
  completedAt?: Date;
  findClipsDiagnostics?: ClipFunnelReport;
}

const jobSchema = new Schema<WorkerJob>({
  queueJobId: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true },
  clipId: { type: Schema.Types.ObjectId, ref: "Clip" },
  captionPreview: { type: Boolean, default: false, required: true },
  type: { type: String, enum: ["analysis", "url-import", "find-clips", "render", "metadata", "recompute-topics"], required: true },
  modelSpeed: { type: String, enum: ["fast", "balanced"], default: "balanced", required: true },
  useGemini: { type: Boolean, default: false, required: true },
  status: { type: String, enum: ["queued", "processing", "retrying", "completed", "failed"], required: true },
  progress: {
    stage: { type: String, required: true },
    message: { type: String, required: true },
    percent: { type: Number, min: 0, max: 100, required: true },
    completedChunks: Number,
    totalChunks: Number,
    etaSeconds: Number
  },
  attemptsMade: { type: Number, min: 0, default: 0 },
  maxAttempts: { type: Number, min: 1, default: 3 },
  failedReason: { type: String, maxlength: 1000 },
  startedAt: Date,
  completedAt: Date,
  findClipsDiagnostics: { type: Schema.Types.Mixed }
}, { timestamps: true });

export interface WorkerTranscript {
  videoId: Types.ObjectId;
  language: string;
  model: string;
  wordCount: number;
  segmentCount: number;
  wordsPath: string;
  segments: TranscriptSegment[];
}

const segmentSchema = new Schema<TranscriptSegment>({
  start: { type: Number, required: true },
  end: { type: Number, required: true },
  text: { type: String, required: true }
}, { _id: false });

const transcriptSchema = new Schema<WorkerTranscript>({
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, unique: true },
  language: { type: String, required: true },
  model: { type: String, required: true },
  wordCount: { type: Number, required: true },
  segmentCount: { type: Number, required: true },
  wordsPath: { type: String, required: true },
  segments: { type: [segmentSchema], default: [] }
}, { timestamps: true });

export interface WorkerAnalysis {
  videoId: Types.ObjectId;
  videoType: VideoType;
  topicSegments?: ClipTopicSegment[];
  topicsMode?: "semantic" | "basic";
  topicWarning?: string;
  heuristics: {
    speechDensityWordsPerMinute: number;
    questionRatio: number;
    meanPauseSeconds: number;
    cueCounts: Record<string, number>;
  };
}

const analysisSchema = new Schema<WorkerAnalysis>({
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, unique: true },
  videoType: { type: String, enum: ["podcast", "interview", "tutorial", "vlog", "other"], required: true },
  heuristics: {
    speechDensityWordsPerMinute: { type: Number, min: 0, required: true },
    questionRatio: { type: Number, min: 0, max: 1, required: true },
    meanPauseSeconds: { type: Number, min: 0, required: true },
    cueCounts: { type: Schema.Types.Mixed, required: true }
  },
  topicSegments: { type: [Schema.Types.Mixed], default: undefined },
  topicsMode: { type: String, enum: ["semantic", "basic"], default: "semantic" },
  topicWarning: { type: String, maxlength: 500 }
}, { timestamps: true });

export interface WorkerClip {
  videoId: Types.ObjectId;
  start: number;
  end: number;
  transcriptText: string;
  signalsFound: string[];
  reason: string;
  topicId: string;
  topicLabel: string;
  heuristicSignalScore: number;
  topicCoherenceScore: number;
  boundaryQualityScore: number;
  boundaryQualityReason?: string;
  ruleStandalone: boolean;
  embedding: number[];
  contentHash?: string;
  score: number;
  breakdown: ClipScoreResult["breakdown"];
  scoringMode: ClipScoreResult["scoringMode"];
  scoringProvider?: ClipScoreResult["scoringProvider"];
  rankingBreakdown?: ClipScoreResult["rankingBreakdown"];
  factorBreakdown?: ClipFactorBreakdown;
  boundaryChanges?: string[];
  standaloneCheck?: ClipStandaloneCheck;
  selectedForRendering: boolean;
  captionStyle: CaptionStyle;
  cleanupCaptionFillers: boolean;
  isStaged?: boolean;
  renderStatus: "not-rendered" | "rendering" | "ready" | "failed";
  renderFilePath?: string;
  captionPreviewFilePath?: string;
  renderSettings?: {
    reframeStrategy: "blur-fit" | "center-crop";
    captionStyle: CaptionStyle;
    cleanupCaptionFillers: boolean;
    width: 1080;
    height: 1920;
    videoCodec: "libx264";
    preset: "veryfast";
    crf: 23;
    threads: 2;
    audioCodec: "aac";
    pixelFormat: "yuv420p";
    faststart: true;
  };
  renderedAt?: Date;
  renderError?: string;
  renderJobId?: Types.ObjectId;
  renderQueueJobId?: string;
  renderProgress?: { message: string; percent: number; etaSeconds?: number };
}

export interface WorkerClipMetadata {
  clipId: Types.ObjectId;
  videoId: Types.ObjectId;
  contentHash?: string;
  result?: ClipMetadataResult;
  mode?: "AI" | "Offline";
  provider?: "Gemini" | "Ollama" | "Offline" | "Gemini + Offline" | "Ollama + Offline";
  fallbackReason?: string;
  warnings: Record<string, string[]>;
  edited: boolean;
  language: MetadataOptions["language"];
  tone: MetadataOptions["tone"];
  includeOriginalCredit: boolean;
  useGemini: boolean;
  generationStatus: "idle" | "queued" | "processing" | "retrying" | "failed";
  generationJobId?: Types.ObjectId;
  generationProgress?: { message: string; percent: number; etaSeconds?: number };
  generationError?: string;
  generatedAt?: Date;
  trendSignals?: TrendSignals;
}

const workerClipMetadataSchema = new Schema<WorkerClipMetadata>({
  clipId: { type: Schema.Types.ObjectId, ref: "Clip", required: true, unique: true },
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, index: true },
  contentHash: { type: String, index: true },
  result: { type: Schema.Types.Mixed },
  mode: { type: String, enum: ["AI", "Offline"] },
  provider: { type: String, enum: ["Gemini", "Ollama", "Offline", "Gemini + Offline", "Ollama + Offline"] },
  fallbackReason: { type: String, maxlength: 1000 },
  warnings: { type: Schema.Types.Mixed, default: {} },
  edited: { type: Boolean, default: false, required: true },
  language: { type: String, enum: ["same", "english"], default: "same", required: true },
  tone: { type: String, enum: ["curious", "direct", "informative"], default: "curious", required: true },
  includeOriginalCredit: { type: Boolean, default: true, required: true },
  useGemini: { type: Boolean, default: false, required: true },
  generationStatus: { type: String, enum: ["idle", "queued", "processing", "retrying", "failed"], default: "idle", required: true },
  generationJobId: { type: Schema.Types.ObjectId, ref: "Job" },
  generationProgress: {
    message: { type: String, maxlength: 500 },
    percent: { type: Number, min: 0, max: 100 },
    etaSeconds: { type: Number, min: 0 }
  },
  generationError: { type: String, maxlength: 1000 },
  generatedAt: Date,
  trendSignals: { type: Schema.Types.Mixed }
}, { timestamps: true });

const scorePartSchema = new Schema({
  score: { type: Number, min: 0, max: 100, required: true },
  reason: { type: String, required: true, maxlength: 160 }
}, { _id: false });

const scoreBreakdownSchema = new Schema({
  hookStrength: { type: scorePartSchema, required: true },
  emotionalPeak: { type: scorePartSchema, required: true },
  standaloneClarity: { type: scorePartSchema, required: true },
  pacing: { type: scorePartSchema, required: true },
  payoff: { type: scorePartSchema, required: true }
}, { _id: false });

const clipSchema = new Schema<WorkerClip>({
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, index: true },
  start: { type: Number, required: true, min: 0 },
  end: { type: Number, required: true, min: 0 },
  transcriptText: { type: String, required: true, maxlength: 20_000 },
  signalsFound: { type: [String], required: true, default: [] },
  reason: { type: String, required: true, maxlength: 500 },
  topicId: { type: String, required: true, maxlength: 40 },
  topicLabel: { type: String, required: true, maxlength: 120 },
  heuristicSignalScore: { type: Number, min: 0, max: 100, required: true },
  topicCoherenceScore: { type: Number, min: 0, max: 100, required: true },
  boundaryQualityScore: { type: Number, min: 0, max: 100, required: true },
  boundaryQualityReason: { type: String, maxlength: 200, default: "Sentence boundaries are intact." },
  ruleStandalone: { type: Boolean, required: true },
  embedding: { type: [Number], required: true, select: false },
  contentHash: { type: String, required: true, index: true },
  score: { type: Number, min: 0, max: 100, required: true },
  breakdown: { type: scoreBreakdownSchema, required: true },
  scoringMode: { type: String, enum: ["AI-scored", "Heuristic-scored"], required: true },
  scoringProvider: { type: String, enum: ["Gemini", "Ollama", "Heuristic"], default: "Heuristic" },
  rankingBreakdown: { type: Schema.Types.Mixed },
  factorBreakdown: { type: Schema.Types.Mixed },
  boundaryChanges: { type: [String], default: [] },
  standaloneCheck: { type: Schema.Types.Mixed },
  selectedForRendering: { type: Boolean, default: false, required: true },
  captionStyle: { type: String, enum: Object.keys(CAPTION_STYLE_CONFIG), default: "clean", required: true },
  cleanupCaptionFillers: { type: Boolean, default: true, required: true },
  isStaged: { type: Boolean, default: false },
  renderStatus: { type: String, enum: ["not-rendered", "rendering", "ready", "failed"], default: "not-rendered", required: true },
  renderFilePath: { type: String, maxlength: 500 },
  captionPreviewFilePath: { type: String, maxlength: 500 },
  renderSettings: {
    reframeStrategy: { type: String, enum: ["blur-fit", "center-crop"] },
    captionStyle: { type: String, enum: Object.keys(CAPTION_STYLE_CONFIG) },
    cleanupCaptionFillers: Boolean,
    width: { type: Number, enum: [1080] },
    height: { type: Number, enum: [1920] },
    videoCodec: { type: String, enum: ["libx264"] },
    preset: { type: String, enum: ["veryfast"] },
    crf: { type: Number, enum: [23] },
    threads: { type: Number, enum: [2] },
    audioCodec: { type: String, enum: ["aac"] },
    pixelFormat: { type: String, enum: ["yuv420p"] },
    faststart: { type: Boolean, enum: [true] }
  },
  renderedAt: Date,
  renderError: { type: String, maxlength: 1000 },
  renderJobId: { type: Schema.Types.ObjectId, ref: "Job" },
  renderQueueJobId: { type: String, maxlength: 150 },
  renderProgress: {
    message: { type: String, maxlength: 500 },
    percent: { type: Number, min: 0, max: 100 },
    etaSeconds: { type: Number, min: 0 }
  }
}, { timestamps: true });

clipSchema.index({ videoId: 1, start: 1 });

interface WorkerClipScoreCache {
  contentHash: string;
  result: ClipScoreResult;
}

const clipScoreCacheSchema = new Schema<WorkerClipScoreCache>({
  contentHash: { type: String, required: true, unique: true },
  result: { type: Schema.Types.Mixed, required: true }
}, { timestamps: true });

interface WorkerTrendCache {
  cacheKey: string;
  signals: unknown;
  expiresAt: Date;
}

const trendCacheSchema = new Schema<WorkerTrendCache>({
  cacheKey: { type: String, required: true, unique: true },
  signals: { type: Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } }
}, { timestamps: true });

interface WorkerTrendQuota {
  day: string;
  unitsUsed: number;
  safetyStopUnits: number;
}

const trendQuotaSchema = new Schema<WorkerTrendQuota>({
  day: { type: String, required: true, unique: true },
  unitsUsed: { type: Number, min: 0, default: 0 },
  safetyStopUnits: { type: Number, min: 0, required: true }
}, { timestamps: true });

export const WorkerVideoModel = model<WorkerVideo>("Video", videoSchema);
export const WorkerJobModel = model<WorkerJob>("Job", jobSchema);
export const WorkerTranscriptModel = model<WorkerTranscript>("Transcript", transcriptSchema);
export const WorkerAnalysisModel = model<WorkerAnalysis>("Analysis", analysisSchema);
export const WorkerClipModel = model<WorkerClip>("Clip", clipSchema);
export const WorkerClipMetadataModel = model<WorkerClipMetadata>("ClipMetadata", workerClipMetadataSchema);
export const WorkerClipScoreCacheModel = model<WorkerClipScoreCache>("ClipScoreCache", clipScoreCacheSchema);
export const WorkerTrendCacheModel = model<WorkerTrendCache>("TrendCache", trendCacheSchema);
export const WorkerTrendQuotaModel = model<WorkerTrendQuota>("TrendQuota", trendQuotaSchema);

export const WorkerUserModel = model("User", new Schema({
  activeAnalysisJobs: { type: Number, min: 0, default: 0 }
}));
