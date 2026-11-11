import { Schema, model, Types } from "mongoose";
import type { VideoType } from "@clipforge/shared";

export type VideoStatus = "uploaded" | "queued" | "processing" | "ready" | "failed";

export interface VideoDocument {
  userId: Types.ObjectId;
  projectId: Types.ObjectId;
  source: "upload" | "url";
  sourceUrl?: string;
  sourceTitle?: string;
  channel?: string;
  originalName: string;
  storageKey: string;
  sizeBytes: number;
  durationSeconds?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  status: VideoStatus;
  currentJobId?: Types.ObjectId;
  detectedType?: VideoType;
  analysisError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const videoSchema = new Schema<VideoDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    source: { type: String, enum: ["upload", "url"], default: "upload", required: true },
    sourceUrl: { type: String, maxlength: 2048 },
    sourceTitle: { type: String, maxlength: 500 },
    channel: { type: String, maxlength: 200 },
    originalName: { type: String, required: true, maxlength: 255 },
    storageKey: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    durationSeconds: { type: Number, min: 0 },
    hasAudio: { type: Boolean, required: true, default: false },
    hasVideo: { type: Boolean, required: true, default: false },
    status: { type: String, enum: ["uploaded", "queued", "processing", "ready", "failed"], default: "uploaded" },
    currentJobId: { type: Schema.Types.ObjectId, ref: "Job" },
    detectedType: { type: String, enum: ["podcast", "interview", "tutorial", "vlog", "other"] },
    analysisError: { type: String, maxlength: 1000 }
  },
  { timestamps: true }
);

videoSchema.index({ userId: 1, createdAt: -1 });
videoSchema.index({ projectId: 1, createdAt: -1 });
videoSchema.index({ status: 1, updatedAt: -1 });

export const Video = model<VideoDocument>("Video", videoSchema);
