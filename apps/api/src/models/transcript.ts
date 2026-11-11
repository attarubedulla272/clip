import { Schema, model, Types } from "mongoose";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptDocument {
  videoId: Types.ObjectId;
  language: string;
  model: string;
  wordCount: number;
  segmentCount: number;
  wordsPath: string;
  segments: TranscriptSegment[];
  createdAt: Date;
  updatedAt: Date;
}

const segmentSchema = new Schema<TranscriptSegment>(
  {
    start: { type: Number, required: true, min: 0 },
    end: { type: Number, required: true, min: 0 },
    text: { type: String, required: true, maxlength: 2000 }
  },
  { _id: false }
);

const transcriptSchema = new Schema<TranscriptDocument>(
  {
    videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, unique: true },
    language: { type: String, required: true, maxlength: 32 },
    model: { type: String, required: true, maxlength: 32 },
    wordCount: { type: Number, required: true, min: 0 },
    segmentCount: { type: Number, required: true, min: 0 },
    wordsPath: { type: String, required: true },
    segments: { type: [segmentSchema], default: [] }
  },
  { timestamps: true }
);

export const Transcript = model<TranscriptDocument>("Transcript", transcriptSchema);
