import { Schema, model } from "mongoose";
import type { UserRole } from "@clipforge/shared";

export interface UserDocument {
  email: string;
  passwordHash: string;
  role: UserRole;
  refreshTokenHash?: string;
  refreshTokenExpiresAt?: Date;
  activeAnalysisJobs: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDocument>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["user", "admin"], default: "user", required: true },
    activeAnalysisJobs: { type: Number, min: 0, default: 0, required: true },
    refreshTokenHash: { type: String, select: false },
    refreshTokenExpiresAt: { type: Date, select: false }
  },
  { timestamps: true }
);

export const User = model<UserDocument>("User", userSchema);
