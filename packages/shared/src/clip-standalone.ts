import { z } from "zod";

export const clipStandaloneAssessmentSchema = z.object({
  standsAlone: z.boolean(),
  reason: z.string().trim().min(1).max(180).refine((value) => !/[\r\n]/u.test(value), "Reason must be one line"),
  suggestedStartAdjustmentSeconds: z.number().finite(),
  suggestedEndAdjustmentSeconds: z.number().finite()
});

export type ClipStandaloneAssessment = z.infer<typeof clipStandaloneAssessmentSchema>;

export type ClipStandaloneCheck = ClipStandaloneAssessment & {
  provider: "Gemini" | "Ollama" | "Rules";
  rulesPass: boolean;
};
