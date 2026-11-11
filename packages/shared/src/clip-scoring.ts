import { z } from "zod";

const scorePartSchema = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string().trim().min(1).max(160).refine((value) => !/[\r\n]/.test(value), "Reason must be one line")
});

const standaloneCheckSchema = z.object({
  isStandalone: z.boolean(),
  reason: z.string().trim().min(1).max(160).refine((value) => !/[\r\n]/.test(value), "Reason must be one line")
});

export const clipScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  breakdown: z.object({
    hookStrength: scorePartSchema,
    emotionalPeak: scorePartSchema,
    standaloneClarity: scorePartSchema,
    pacing: scorePartSchema,
    payoff: scorePartSchema
  }),
  standaloneCheck: standaloneCheckSchema.optional()
}).transform((value) => ({
  ...value,
  standaloneCheck: value.standaloneCheck ?? {
    isStandalone: true,
    reason: "No standalone-check flag was returned; defaulted to safe and complete."
  }
}));

export type ClipScore = z.infer<typeof clipScoreSchema>;
export type ClipScoringMode = "AI-scored" | "Heuristic-scored";

export const clipRankingFactorSchema = z.object({
  score: z.number().int().min(0).max(100),
  weight: z.number().min(0).max(1),
  contribution: z.number().min(0).max(100),
  reason: z.string().trim().min(1).max(200)
});

export const clipRankingBreakdownSchema = z.object({
  llmScore: clipRankingFactorSchema,
  heuristicSignals: clipRankingFactorSchema,
  hookStrength: clipRankingFactorSchema,
  topicCoherence: clipRankingFactorSchema,
  boundaryQuality: clipRankingFactorSchema
});

export type ClipRankingFactor = z.infer<typeof clipRankingFactorSchema>;
export type ClipRankingBreakdown = z.infer<typeof clipRankingBreakdownSchema>;

export const clipFactorNames = [
  "llmHighlight",
  "speechPace",
  "audioEnergy",
  "questionsPauses",
  "hookStrength",
  "topicCoherence",
  "boundaryQuality",
  "novelty"
] as const;
export type ClipFactorName = typeof clipFactorNames[number];
export type ClipFactorBreakdown = Record<ClipFactorName, ClipRankingFactor>;

export interface ClipScoreResult extends ClipScore {
  scoringMode: ClipScoringMode;
  scoringProvider: "Gemini" | "Ollama" | "Heuristic";
  rankingBreakdown: ClipRankingBreakdown;
}

export interface ClipScoreInput {
  transcriptText: string;
  signalsFound: string[];
  durationSeconds: number;
  topicLabel?: string;
  heuristicSignalScore?: number;
  heuristicSignalReason?: string;
  topicCoherenceScore?: number;
  boundaryQualityScore?: number;
  boundaryQualityReason?: string;
  ruleStandalone?: boolean;
}
