import { createHash } from "node:crypto";
import {
  clipScoreSchema,
  type ClipRankingBreakdown,
  type ClipScore,
  type ClipScoreInput,
  type ClipScoreResult
} from "@clipforge/shared/clip-scoring";
import { CLIP_RANKING_WEIGHTS } from "../clips/ranking-config.js";
import type { LlmProvider } from "./llm-provider.js";

export interface ClipScoreCache {
  get(contentHash: string): Promise<ClipScoreResult | undefined>;
  set(contentHash: string, result: ClipScoreResult): Promise<ClipScoreResult>;
}

export interface ClipScoreOutcome {
  contentHash: string;
  result: ClipScoreResult;
  cached: boolean;
  accepted: boolean;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function average(values: number[]) {
  return values.length === 0 ? 0 : clampScore(values.reduce((sum, value) => sum + value, 0) / values.length);
}

type NormalizedClipScoreInput = Required<Pick<
  ClipScoreInput,
  "topicLabel" | "heuristicSignalScore" | "heuristicSignalReason" |
  "topicCoherenceScore" | "boundaryQualityScore" | "boundaryQualityReason" | "ruleStandalone"
>> & ClipScoreInput;

function normalizeClipScoreInput(input: ClipScoreInput): NormalizedClipScoreInput {
  return {
    ...input,
    topicLabel: input.topicLabel ?? "general topic",
    heuristicSignalScore: input.heuristicSignalScore ?? 50,
    heuristicSignalReason: input.heuristicSignalReason ?? "No special signal noted.",
    topicCoherenceScore: input.topicCoherenceScore ?? 50,
    boundaryQualityScore: input.boundaryQualityScore ?? 50,
    boundaryQualityReason: input.boundaryQualityReason ?? "Sentence boundaries are intact.",
    ruleStandalone: input.ruleStandalone ?? true
  } as NormalizedClipScoreInput;
}

function buildRankingBreakdown(input: ClipScoreInput, score: ClipScore): ClipRankingBreakdown {
  const normalized = normalizeClipScoreInput(input);
  const hookScore = score.breakdown.hookStrength.score;
  const factors: Record<string, { score: number; weight: number; reason: string }> = {
    llmScore: {
      score: score.score,
      weight: CLIP_RANKING_WEIGHTS.llmHighlight,
      reason: "The candidate's five-part scoring result."
    },
    heuristicSignals: {
      score: normalized.heuristicSignalScore,
      weight: CLIP_RANKING_WEIGHTS.speechPace + CLIP_RANKING_WEIGHTS.audioEnergy + CLIP_RANKING_WEIGHTS.questionsPauses,
      reason: normalized.heuristicSignalReason
    },
    hookStrength: {
      score: hookScore,
      weight: CLIP_RANKING_WEIGHTS.hookStrength,
      reason: score.breakdown.hookStrength.reason
    },
    topicCoherence: {
      score: normalized.topicCoherenceScore,
      weight: CLIP_RANKING_WEIGHTS.topicCoherence,
      reason: `Transcript sentences stay together in the semantic topic “${normalized.topicLabel}”.`
    },
    boundaryQuality: {
      score: normalized.boundaryQualityScore,
      weight: CLIP_RANKING_WEIGHTS.boundaryQuality,
      reason: normalized.boundaryQualityReason
    }
  };

  const rankingBreakdown = Object.fromEntries(
    Object.entries(factors).map(([name, factor]) => [name, {
      ...factor,
      contribution: factor.score * factor.weight
    }])
  ) as ClipRankingBreakdown;

  score.score = clampScore(Object.values(rankingBreakdown)
    .reduce((total, factor) => total + factor.contribution, 0));
  return rankingBreakdown;
}

function withRanking(input: ClipScoreInput, parts: ClipScore): ClipScoreResult {
  const rankingBreakdown = buildRankingBreakdown(input, parts);
  return {
    ...parts,
    scoringMode: "Heuristic-scored",
    scoringProvider: "Heuristic",
    rankingBreakdown
  };
}

export function scoreHeuristically(input: ClipScoreInput): ClipScoreResult {
  const normalized = normalizeClipScoreInput(input);
  const signals = new Set(normalized.signalsFound);
  const words = normalized.transcriptText.trim().split(/\s+/).filter(Boolean);
  const hasQuestion = signals.has("Question");
  const hasExclamation = signals.has("Exclamation");
  const hasEnergyPeak = signals.has("Audio energy peak");
  const hasPause = signals.has("Natural pause at a clip boundary");
  const hasLivelyPace = signals.has("Lively speech pace");
  const hasKeyword = normalized.signalsFound.some((signal) => signal.startsWith("Repeated keywords:"));
  const sentences = normalized.transcriptText.split(/[.!?।]+/u).filter((sentence) => sentence.trim().length > 0);

  const parts: ClipScore = {
    score: 0,
    breakdown: {
      hookStrength: {
        score: clampScore(38 + (hasQuestion ? 18 : 0) + (hasExclamation ? 12 : 0) +
          (hasEnergyPeak ? 18 : 0) + (hasKeyword ? 10 : 0)),
        reason: hasQuestion || hasExclamation
          ? "A question or emphatic wording gives the opening a clear hook."
          : "No question or emphatic opening signal was detected."
      },
      emotionalPeak: {
        score: clampScore(38 + (hasEnergyPeak ? 28 : 0) + (hasExclamation ? 22 : 0) + (hasQuestion ? 8 : 0)),
        reason: hasEnergyPeak || hasExclamation
          ? "An audio peak or emphatic wording suggests a moment of emphasis."
          : "No strong audio or punctuation emphasis was detected."
      },
      standaloneClarity: {
        score: clampScore((normalized.ruleStandalone ? 68 : 34) +
          (words.length >= 35 && words.length <= 240 ? 14 : 0) + (sentences.length >= 2 ? 10 : 0)),
        reason: normalized.ruleStandalone
          ? "The opening has no unresolved reference and the clip ends on a complete boundary."
          : "The opening may depend on context from outside the clip."
      },
      pacing: {
        score: clampScore((hasLivelyPace ? 72 : 54) + (hasPause ? 12 : 0) +
          (normalized.durationSeconds > 50 ? -8 : 0)),
        reason: hasLivelyPace || hasPause
          ? "Speech pace or a natural pause gives the passage a clear rhythm."
          : "No distinct pace or pause signal was detected."
      },
      payoff: {
        score: clampScore(40 + (hasPause ? 12 : 0) + (hasKeyword ? 10 : 0) +
          (/[.!?।]["'”’)\]]*$/u.test(normalized.transcriptText.trim()) ? 20 : 0) +
          (sentences.length >= 2 ? 10 : 0)),
        reason: /[.!?।]["'”’)\]]*$/u.test(normalized.transcriptText.trim())
          ? "The transcript ends on sentence punctuation, suggesting a completed thought."
          : "The transcript has no final sentence punctuation, so its ending is less certain."
      }
    },
    standaloneCheck: {
      isStandalone: normalized.ruleStandalone,
      reason: normalized.ruleStandalone
        ? "Rule check: the clip starts with a resolved sentence and ends at a sentence or pause."
        : "Rule check: the clip may start with an unresolved reference."
    }
  };
  parts.score = average(Object.values(parts.breakdown).map((part) => part.score));
  return withRanking(normalized, parts);
}

export async function requestValidatedScore(provider: LlmProvider, input: ClipScoreInput): Promise<ClipScore> {
  const providerName = provider.providerName ?? "Ollama";
  let lastValidationError = `${providerName} returned invalid score JSON`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await provider.generateScoreJson(input);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lastValidationError = `${providerName} returned invalid JSON`;
      continue;
    }
    const result = clipScoreSchema.safeParse(parsed);
    if (result.success) return result.data;
    lastValidationError = `${providerName} returned invalid score data: ${result.error.issues.map((issue) => issue.message).join(", ")}`;
  }
  throw new Error(lastValidationError);
}

export function clipContentHash(input: ClipScoreInput, providerNames: string[]) {
  const normalized = normalizeClipScoreInput(input);
  const content = JSON.stringify({
    version: 2,
    providerNames,
    transcriptText: normalized.transcriptText.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
    signalsFound: [...normalized.signalsFound].sort(),
    durationSeconds: Math.round(normalized.durationSeconds * 10) / 10,
    topicLabel: normalized.topicLabel,
    heuristicSignalScore: normalized.heuristicSignalScore,
    topicCoherenceScore: normalized.topicCoherenceScore,
    boundaryQualityScore: normalized.boundaryQualityScore,
    boundaryQualityReason: normalized.boundaryQualityReason,
    ruleStandalone: normalized.ruleStandalone,
    rankingWeights: CLIP_RANKING_WEIGHTS
  });
  return createHash("sha256").update(content).digest("hex");
}

export async function scoreClipWithFallback(
  input: ClipScoreInput,
  providers: LlmProvider | LlmProvider[],
  cache: ClipScoreCache
): Promise<ClipScoreOutcome> {
  const providerList = Array.isArray(providers) ? providers : [providers];
  const contentHash = clipContentHash(input, providerList.map((provider) => `${provider.providerName ?? "Ollama"}:${provider.modelName}`));
  const cached = await cache.get(contentHash);
  if (cached) return { contentHash, result: cached, cached: true, accepted: cached.standaloneCheck.isStandalone };

  let rejectedByStandaloneCheck: { result: ClipScore; provider: LlmProvider } | undefined;
  for (const provider of providerList) {
    try {
      const score = await requestValidatedScore(provider, input);
      if (!score.standaloneCheck.isStandalone) {
        rejectedByStandaloneCheck = { result: score, provider };
        continue;
      }
      const result = withRanking(input, score);
      result.scoringMode = "AI-scored";
      result.scoringProvider = provider.providerName ?? "Ollama";
      return {
        contentHash,
        result: await cache.set(contentHash, result),
        cached: false,
        accepted: true
      };
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        event: "clip.score.provider.failed",
        contentHash,
        provider: provider.providerName ?? "Ollama",
        modelName: provider.modelName,
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  if (rejectedByStandaloneCheck) {
    const result: ClipScoreResult = {
      ...rejectedByStandaloneCheck.result,
      scoringMode: "AI-scored",
      scoringProvider: rejectedByStandaloneCheck.provider.providerName ?? "Ollama",
      rankingBreakdown: buildRankingBreakdown(input, rejectedByStandaloneCheck.result)
    };
    return { contentHash, result, cached: false, accepted: false };
  }

  const result = scoreHeuristically(input);
  return {
    contentHash,
    result: await cache.set(contentHash, result),
    cached: false,
    accepted: true
  };
}
