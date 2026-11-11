import { Schema, model, Types } from "mongoose";
import type { ClipMetadataResult, MetadataOptions } from "@clipforge/shared/clip-metadata";
import type { TrendSignals } from "@clipforge/shared/clip-metadata";

export interface ClipMetadataDocument {
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
  createdAt: Date;
  updatedAt: Date;
}

const clipMetadataSchema = new Schema<ClipMetadataDocument>({
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

export const ClipMetadata = model<ClipMetadataDocument>("ClipMetadata", clipMetadataSchema);
