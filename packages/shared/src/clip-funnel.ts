import { z } from "zod";

export const clipFunnelRemovalReasonSchema = z.enum([
  "boundary-rule",
  "duration-limit",
  "duplicate-window",
  "candidate-limit",
  "scoring-shortlist",
  "overlap",
  "near-duplicate",
  "low-score",
  "mmr-diversity"
]);

export const clipFunnelRemovalSchema = z.object({
  start: z.number().finite().min(0),
  end: z.number().finite().positive(),
  reason: clipFunnelRemovalReasonSchema,
  detail: z.string().trim().min(1).max(240)
}).refine((entry) => entry.end > entry.start, "Removal range end must follow start");

export const clipFunnelReportSchema = z.object({
  attemptedCount: z.number().int().min(0).optional(),
  generatedCount: z.number().int().min(0),
  candidatePoolCount: z.number().int().min(0).optional(),
  scoredCount: z.number().int().min(0),
  selectedCount: z.number().int().min(0),
  thresholds: z.record(z.string(), z.unknown()),
  removalCounts: z.record(clipFunnelRemovalReasonSchema, z.number().int().min(0)),
  removals: z.array(clipFunnelRemovalSchema).max(2000)
});

export type ClipFunnelRemovalReason = z.infer<typeof clipFunnelRemovalReasonSchema>;
export type ClipFunnelRemoval = z.infer<typeof clipFunnelRemovalSchema>;
export type ClipFunnelReport = z.infer<typeof clipFunnelReportSchema>;
