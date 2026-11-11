import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(128)
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(128)
});

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100)
});

export const uploadVideoParamsSchema = z.object({
  projectId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid project ID")
});

export const userRoleSchema = z.enum(["user", "admin"]);
export const videoTypeSchema = z.enum(["podcast", "interview", "tutorial", "vlog", "other"]);

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type VideoType = z.infer<typeof videoTypeSchema>;
