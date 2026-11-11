import { Schema, model, Types } from "mongoose";

export interface UploadSessionDocument {
  _id: string;
  userId: Types.ObjectId;
  projectId: Types.ObjectId;
  originalName: string;
  contentType: string;
  expectedSizeBytes: number;
  offsetBytes: number;
  storageKey: string;
  status: "uploading";
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const uploadSessionSchema = new Schema<UploadSessionDocument>({
  _id: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
  originalName: { type: String, required: true, maxlength: 255 },
  contentType: { type: String, required: true },
  expectedSizeBytes: { type: Number, min: 1, required: true },
  offsetBytes: { type: Number, min: 0, required: true, default: 0 },
  storageKey: { type: String, required: true, unique: true },
  status: { type: String, enum: ["uploading"], required: true, default: "uploading" },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

uploadSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
uploadSessionSchema.index({ userId: 1, status: 1, expiresAt: 1 });

export const UploadSession = model<UploadSessionDocument>("UploadSession", uploadSessionSchema);
