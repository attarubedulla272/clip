import { Schema, model, Types } from "mongoose";
import type { ClipFunnelReport } from "@clipforge/shared/clip-funnel";

export type AnalysisJobStatus = "queued" | "processing" | "retrying" | "completed" | "failed";

export interface JobProgress {
  stage: string;
  message: string;
  percent: number;
  completedChunks?: number;
  totalChunks?: number;
  etaSeconds?: number;
}

export interface JobDocument {
  queueJobId: string;
  userId: Types.ObjectId;
  videoId: Types.ObjectId;
  clipId?: Types.ObjectId;
  captionPreview: boolean;
  previewId?: string;
  type: "analysis" | "url-import" | "find-clips" | "render" | "metadata" | "recompute-topics";
  modelSpeed: "fast" | "balanced";
  useGemini: boolean;
  status: AnalysisJobStatus;
  progress: JobProgress;
  attemptsMade: number;
  maxAttempts: number;
  failedReason?: string;
  startedAt?: Date;
  completedAt?: Date;
  findClipsDiagnostics?: ClipFunnelReport;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<JobDocument>(
  {
    queueJobId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true },
    type: { type: String, enum: ["analysis", "url-import", "find-clips", "render", "metadata", "recompute-topics"], required: true },
    clipId: { type: Schema.Types.ObjectId, ref: "Clip" },
    captionPreview: { type: Boolean, default: false, required: true },
    previewId: { type: String, maxlength: 100 },
    modelSpeed: { type: String, enum: ["fast", "balanced"], default: "balanced", required: true },
    useGemini: { type: Boolean, default: false, required: true },
    status: { type: String, enum: ["queued", "processing", "retrying", "completed", "failed"], required: true },
    progress: {
      stage: { type: String, required: true },
      message: { type: String, required: true },
      percent: { type: Number, min: 0, max: 100, required: true },
      completedChunks: { type: Number, min: 0 },
      totalChunks: { type: Number, min: 0 },
      etaSeconds: { type: Number, min: 0 }
    },
    attemptsMade: { type: Number, min: 0, default: 0 },
    maxAttempts: { type: Number, min: 1, default: 3 },
    failedReason: { type: String, maxlength: 1000 },
    startedAt: Date,
    completedAt: Date,
    findClipsDiagnostics: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

jobSchema.index({ userId: 1, createdAt: -1 });
jobSchema.index({ status: 1, updatedAt: -1 });
jobSchema.index({ videoId: 1, createdAt: -1 });

export const Job = model<JobDocument>("Job", jobSchema);
