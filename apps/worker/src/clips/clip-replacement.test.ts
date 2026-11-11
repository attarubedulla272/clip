import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { ClipScoreResult } from "@clipforge/shared/clip-scoring";
import { WorkerClipModel } from "../models.js";
import { createStagedClipDocument, stageThenSwap, validateStagedClipDocuments } from "./clip-replacement.js";
import { rankScoredCandidates } from "./ranking.js";
import type { ClipCandidate } from "./shortlist.js";

const candidate: ClipCandidate = {
  start: 5,
  end: 25,
  transcriptText: "A complete sentence-bounded candidate.",
  signalsFound: ["Question", "Natural pause at a clip boundary"],
  reason: "A clear question followed by a natural pause.",
  topicId: "topic-1",
  topicLabel: "Clear question",
  heuristicSignalScore: 72,
  topicCoherenceScore: 84,
  boundaryQualityScore: 90,
  boundaryQualityReason: "Starts and ends at complete sentence boundaries.",
  ruleStandalone: true,
  embedding: Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0)
};

const score: ClipScoreResult = {
  score: 76,
  breakdown: {
    hookStrength: { score: 80, reason: "Opens with a direct question." },
    emotionalPeak: { score: 60, reason: "No strong emotional peak." },
    standaloneClarity: { score: 80, reason: "The idea is understandable alone." },
    pacing: { score: 75, reason: "The passage has a natural rhythm." },
    payoff: { score: 85, reason: "It ends on a complete thought." }
  },
  standaloneCheck: { isStandalone: true, reason: "The candidate is understandable alone." },
  scoringMode: "Heuristic-scored",
  scoringProvider: "Heuristic",
  rankingBreakdown: {
    llmScore: { score: 76, weight: 0.4, contribution: 30.4, reason: "Five-part score." },
    heuristicSignals: { score: 72, weight: 0.2, contribution: 14.4, reason: "Existing transcript signals." },
    hookStrength: { score: 80, weight: 0.15, contribution: 12, reason: "Opening question." },
    topicCoherence: { score: 84, weight: 0.15, contribution: 12.6, reason: "Topic coherence." },
    boundaryQuality: { score: 90, weight: 0.1, contribution: 9, reason: "Complete boundaries." }
  }
};

describe("Mongoose clip replacement", () => {
  it("validates the exact scored Find clips record with the real Mongoose Clip model", async () => {
    const document = createStagedClipDocument(new Types.ObjectId(), {
      candidate,
      contentHash: "a".repeat(64),
      result: score
    });

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.scoringProvider).toBe("Heuristic");
    expect(document.rankingBreakdown).toEqual(score.rankingBreakdown);
    expect(document.boundaryQualityReason).toBe(candidate.boundaryQualityReason);
  });

  it("validates the normalized factor breakdown on a real Mongoose Clip instance", async () => {
    const candidateWithBoundaries: ClipCandidate = {
      ...candidate,
      boundaryChanges: ["Started 4.0s earlier to include the preceding context."],
      standaloneCheck: {
        standsAlone: true,
        reason: "The adjusted clip passes the rules check.",
        suggestedStartAdjustmentSeconds: -4,
        suggestedEndAdjustmentSeconds: 0,
        provider: "Ollama",
        rulesPass: true
      }
    };
    const ranked = rankScoredCandidates([
      { candidate: candidateWithBoundaries, contentHash: "e".repeat(64), result: score, cached: false },
      { candidate: { ...candidate, start: 45, end: 65, topicId: "topic-2" }, contentHash: "f".repeat(64), result: score, cached: false }
    ])[0]!;
    const document = createStagedClipDocument(new Types.ObjectId(), {
      ...ranked,
      finalScore: ranked.score,
      factorBreakdown: ranked.factorBreakdown
    });

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.factorBreakdown?.llmHighlight.weight).toBeGreaterThan(0);
    expect(document.factorBreakdown?.novelty.score).toBeGreaterThanOrEqual(0);
    expect(document.boundaryChanges).toEqual(candidateWithBoundaries.boundaryChanges);
    expect(document.standaloneCheck?.provider).toBe("Ollama");
  });

  it("still validates an older clip without the new ranking fields", async () => {
    const legacy = new WorkerClipModel({
      videoId: new Types.ObjectId(),
      start: 2,
      end: 22,
      transcriptText: "An older persisted clip record.",
      signalsFound: [],
      reason: "A clear, complete thought.",
      topicId: "topic-1",
      topicLabel: "Older topic",
      heuristicSignalScore: 50,
      topicCoherenceScore: 50,
      boundaryQualityScore: 50,
      ruleStandalone: true,
      embedding: Array.from({ length: 384 }, () => 0),
      contentHash: "b".repeat(64),
      score: 50,
      breakdown: score.breakdown,
      scoringMode: "Heuristic-scored",
      selectedForRendering: false
    });

    await expect(legacy.validate()).resolves.toBeUndefined();
    expect(legacy.scoringProvider).toBe("Heuristic");
    expect(legacy.boundaryQualityReason).toBe("Sentence boundaries are intact.");
    expect(legacy.rankingBreakdown).toBeUndefined();
  });

  it("uses safe defaults when a cached score predates the provider and ranking fields", async () => {
    const { scoringProvider: _provider, rankingBreakdown: _ranking, ...legacyCachedScore } = score;
    const { boundaryQualityReason: _boundaryReason, ...candidateWithoutBoundaryReason } = candidate;
    const document = createStagedClipDocument(new Types.ObjectId(), {
      candidate: candidateWithoutBoundaryReason,
      contentHash: "d".repeat(64),
      result: legacyCachedScore
    });

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.scoringProvider).toBe("Heuristic");
    expect(document.rankingBreakdown).toBeUndefined();
    expect(document.boundaryQualityReason).toBe("Sentence boundaries are intact.");
  });

  it("keeps the existing clips when staging a replacement fails", async () => {
    const oldClips = [{ id: "old-1" }, { id: "old-2" }];
    const swap = vi.fn(async () => {
      oldClips.splice(0, oldClips.length);
    });
    const rollback = vi.fn(async () => undefined);

    await expect(stageThenSwap(
      async () => {
        await validateStagedClipDocuments([
          createStagedClipDocument(new Types.ObjectId(), {
            candidate: { ...candidate, transcriptText: "x".repeat(20_001) },
            contentHash: "c".repeat(64),
            result: score
          })
        ]);
        return ["staged-1"];
      },
      swap,
      rollback
    )).rejects.toThrow("transcriptText");

    expect(oldClips).toEqual([{ id: "old-1" }, { id: "old-2" }]);
    expect(swap).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });
});
