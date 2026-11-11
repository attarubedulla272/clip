import { describe, expect, it } from "vitest";
import type { ClipFactorBreakdown, ClipScoreResult } from "@clipforge/shared/clip-scoring";
import { CLIP_RANKING_WEIGHTS, rankingWeightsTotal } from "./ranking-config.js";
import type { ClipCandidate } from "./shortlist.js";
import {
  factorWeightsTotal,
  normalizeFactorScores,
  rankScoredCandidates,
  removeNearDuplicateCandidates,
  selectDiverseCandidates
} from "./ranking.js";

const scoreResult: ClipScoreResult = {
  score: 80,
  breakdown: {
    hookStrength: { score: 80, reason: "A clear hook." },
    emotionalPeak: { score: 70, reason: "Emphasis is present." },
    standaloneClarity: { score: 80, reason: "The idea stands alone." },
    pacing: { score: 75, reason: "Pacing is steady." },
    payoff: { score: 80, reason: "The ending resolves the thought." }
  },
  standaloneCheck: { isStandalone: true, reason: "Standalone." },
  scoringMode: "Heuristic-scored",
  scoringProvider: "Heuristic",
  rankingBreakdown: {
    llmScore: { score: 80, weight: 0.3, contribution: 24, reason: "Model guidance." },
    heuristicSignals: { score: 70, weight: 0.34, contribution: 23.8, reason: "Transcript signals." },
    hookStrength: { score: 80, weight: 0.12, contribution: 9.6, reason: "Hook." },
    topicCoherence: { score: 80, weight: 0.1, contribution: 8, reason: "Topic." },
    boundaryQuality: { score: 80, weight: 0.08, contribution: 6.4, reason: "Boundary." }
  }
};

function candidate(
  start: number,
  text: string,
  embedding: number[],
  topicId: string
): ClipCandidate {
  return {
    start,
    end: start + 30,
    transcriptText: text,
    signalsFound: [],
    reason: "Candidate reason.",
    topicId,
    topicLabel: topicId,
    speechPaceScore: 60 + start % 30,
    audioEnergyScore: 70,
    questionsPausesScore: 65,
    hookStrengthScore: 75,
    topicCoherenceScore: 80,
    boundaryQualityScore: 90,
    boundaryQualityReason: "Complete sentences.",
    embedding
  };
}

describe("ranking factors", () => {
  it("normalizes factor values as within-video percentile scores", () => {
    expect(normalizeFactorScores([10, 20, 30])).toEqual([0, 50, 100]);
    expect(normalizeFactorScores([50, 50, 50])).toEqual([50, 50, 50]);
  });

  it("keeps all factor weights in one config and totals one", () => {
    expect(rankingWeightsTotal()).toBe(1);
    expect(factorWeightsTotal()).toBe(1);
    expect(Object.keys(CLIP_RANKING_WEIGHTS)).toEqual([
      "llmHighlight", "speechPace", "audioEnergy", "questionsPauses",
      "hookStrength", "topicCoherence", "boundaryQuality", "novelty"
    ]);
  });
});

describe("duplicate removal and MMR diversity", () => {
  it("removes near-duplicate text-embedding candidates in favor of the higher-ranked one", () => {
    const scored = rankScoredCandidates([
      { candidate: candidate(0, "A distinctive explanation of the same subject.", [1, 0], "topic-a"), result: scoreResult, contentHash: "a", cached: false },
      { candidate: candidate(60, "A distinctive explanation of the same subject.", [1, 0], "topic-b"), result: scoreResult, contentHash: "b", cached: false },
      { candidate: candidate(120, "An unrelated cooking technique with clear steps.", [0, 1], "topic-c"), result: scoreResult, contentHash: "c", cached: false }
    ]);

    const unique = removeNearDuplicateCandidates(scored);
    expect(unique).toHaveLength(2);
    expect(unique.filter((entry) => entry.candidate.transcriptText === "A distinctive explanation of the same subject.")).toHaveLength(1);
    expect(unique.some((entry) => entry.candidate.topicId === "topic-c")).toBe(true);
  });

  it("does not select both near-identical clips and avoids overlapping moments", () => {
    const ranked = rankScoredCandidates([
      { candidate: candidate(0, "The same semantic clip text.", [1, 0], "topic-a"), result: scoreResult, contentHash: "a", cached: false },
      { candidate: candidate(40, "The same semantic clip text.", [1, 0], "topic-b"), result: scoreResult, contentHash: "b", cached: false },
      { candidate: candidate(90, "A different topic and a separate explanation.", [0, 1], "topic-c"), result: scoreResult, contentHash: "c", cached: false }
    ]);

    const selected = selectDiverseCandidates(ranked);
    expect(selected).toHaveLength(2);
    expect(selected.some((entry) => entry.candidate.transcriptText === "A different topic and a separate explanation.")).toBe(true);
    for (let left = 0; left < selected.length; left += 1) {
      for (let right = left + 1; right < selected.length; right += 1) {
        expect(Math.min(selected[left]!.candidate.end, selected[right]!.candidate.end) -
          Math.max(selected[left]!.candidate.start, selected[right]!.candidate.start)).toBeLessThanOrEqual(0);
      }
    }
    const factors = selected[0]?.factorBreakdown as ClipFactorBreakdown | undefined;
    expect(factors?.novelty.weight).toBe(CLIP_RANKING_WEIGHTS.novelty);
  });
});
