import { Schema, model, Types } from "mongoose";
import type { VideoType } from "@clipforge/shared";
import type { ClipTopicSegment } from "@clipforge/shared/clip-topics";

export interface AnalysisDocument {
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
  createdAt: Date;
  updatedAt: Date;
}

const analysisSchema = new Schema<AnalysisDocument>(
  {
    videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, unique: true },
    videoType: {
      type: String,
      enum: ["podcast", "interview", "tutorial", "vlog", "other"],
      required: true
    },
    topicSegments: { type: [Schema.Types.Mixed], default: undefined },
    topicsMode: { type: String, enum: ["semantic", "basic"], default: "semantic" },
    topicWarning: { type: String, maxlength: 500 },
    heuristics: {
      speechDensityWordsPerMinute: { type: Number, min: 0, required: true },
      questionRatio: { type: Number, min: 0, max: 1, required: true },
      meanPauseSeconds: { type: Number, min: 0, required: true },
      cueCounts: { type: Schema.Types.Mixed, required: true }
    }
  },
  { timestamps: true }
);

export const Analysis = model<AnalysisDocument>("Analysis", analysisSchema);
