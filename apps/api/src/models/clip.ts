import { Schema, model, Types } from "mongoose";
import type { ClipFactorBreakdown, ClipScoreResult } from "@clipforge/shared/clip-scoring";
import type { ClipStandaloneCheck } from "@clipforge/shared/clip-standalone";
import { CAPTION_STYLE_CONFIG, type CaptionStyle } from "@clipforge/shared/caption-config";

export type ReframeStrategy = "blur-fit" | "center-crop";
export type ClipRenderStatus = "not-rendered" | "rendering" | "ready" | "failed";

export interface ClipRenderProgress {
  message: string;
  percent: number;
  etaSeconds?: number;
}

export interface ClipRenderSettings {
  reframeStrategy: ReframeStrategy;
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
}

export interface ClipDocument {
  videoId: Types.ObjectId;
  start: number;
  end: number;
  transcriptText: string;
  signalsFound: string[];
  reason: string;
  topicId: string;
  topicLabel: string;
  scoringProvider?: ClipScoreResult["scoringProvider"];
  rankingBreakdown?: ClipScoreResult["rankingBreakdown"];
  factorBreakdown?: ClipFactorBreakdown;
  boundaryQualityReason?: string;
  boundaryQualityScore?: number;
  boundaryChanges?: string[];
  standaloneCheck?: ClipStandaloneCheck;
  isStaged?: boolean;
  contentHash: string;
  score: number;
  breakdown: ClipScoreResult["breakdown"];
  scoringMode: ClipScoreResult["scoringMode"];
  selectedForRendering: boolean;
  captionStyle: CaptionStyle;
  cleanupCaptionFillers: boolean;
  renderStatus: ClipRenderStatus;
  renderFilePath?: string;
  captionPreviewFilePath?: string;
  renderSettings?: ClipRenderSettings;
  renderedAt?: Date;
  renderError?: string;
  renderJobId?: Types.ObjectId;
  renderQueueJobId?: string;
  renderProgress?: ClipRenderProgress;
  createdAt: Date;
  updatedAt: Date;
}

const clipSchema = new Schema<ClipDocument>(
  {
    videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, index: true },
    start: { type: Number, required: true, min: 0 },
    end: { type: Number, required: true, min: 0 },
    transcriptText: { type: String, required: true, maxlength: 20_000 },
    signalsFound: { type: [String], required: true, default: [] },
    reason: { type: String, required: true, maxlength: 500 },
    topicId: { type: String, required: true, maxlength: 40 },
    topicLabel: { type: String, required: true, maxlength: 120 },
    contentHash: { type: String, required: true },
    score: { type: Number, min: 0, max: 100, required: true },
    breakdown: {
      hookStrength: { score: { type: Number, min: 0, max: 100, required: true }, reason: { type: String, required: true, maxlength: 160 } },
      emotionalPeak: { score: { type: Number, min: 0, max: 100, required: true }, reason: { type: String, required: true, maxlength: 160 } },
      standaloneClarity: { score: { type: Number, min: 0, max: 100, required: true }, reason: { type: String, required: true, maxlength: 160 } },
      pacing: { score: { type: Number, min: 0, max: 100, required: true }, reason: { type: String, required: true, maxlength: 160 } },
      payoff: { score: { type: Number, min: 0, max: 100, required: true }, reason: { type: String, required: true, maxlength: 160 } }
    },
    scoringMode: { type: String, enum: ["AI-scored", "Heuristic-scored"], required: true },
    scoringProvider: { type: String, enum: ["Gemini", "Ollama", "Heuristic"], default: "Heuristic" },
    rankingBreakdown: { type: Schema.Types.Mixed },
    factorBreakdown: { type: Schema.Types.Mixed },
    boundaryQualityScore: { type: Number, min: 0, max: 100 },
    boundaryChanges: { type: [String], default: [] },
    standaloneCheck: { type: Schema.Types.Mixed },
    boundaryQualityReason: { type: String, maxlength: 200, default: "Sentence boundaries are intact." },
    selectedForRendering: { type: Boolean, default: false, required: true },
    captionStyle: { type: String, enum: Object.keys(CAPTION_STYLE_CONFIG), default: "clean", required: true },
    cleanupCaptionFillers: { type: Boolean, default: true, required: true },
    isStaged: { type: Boolean, default: false },
    renderStatus: { type: String, enum: ["not-rendered", "rendering", "ready", "failed"], default: "not-rendered", required: true },
    renderFilePath: { type: String, maxlength: 500 },
    captionPreviewFilePath: { type: String, maxlength: 500 },
    renderSettings: {
      reframeStrategy: { type: String, enum: ["blur-fit", "center-crop"] },
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
  },
  { timestamps: true }
);

clipSchema.index({ videoId: 1, start: 1 });

export const Clip = model<ClipDocument>("Clip", clipSchema);
