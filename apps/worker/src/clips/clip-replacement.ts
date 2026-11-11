import { Types } from "mongoose";
import type { ClipFactorBreakdown, ClipScoreResult } from "@clipforge/shared/clip-scoring";
import { WorkerClipModel, type WorkerClip } from "../models.js";
import type { ClipCandidate } from "./shortlist.js";

export interface ScoredClipCandidate {
  candidate: ClipCandidate;
  contentHash: string;
  result: Omit<ClipScoreResult, "scoringProvider" | "rankingBreakdown"> &
    Partial<Pick<ClipScoreResult, "scoringProvider" | "rankingBreakdown">>;
  finalScore?: number;
  factorBreakdown?: ClipFactorBreakdown;
}

export function createStagedClipDocument(videoId: Types.ObjectId, scored: ScoredClipCandidate) {
  const { candidate, contentHash, result } = scored;
  return new WorkerClipModel({
    videoId,
    start: candidate.start,
    end: candidate.end,
    transcriptText: candidate.transcriptText,
    signalsFound: candidate.signalsFound,
    reason: candidate.reason,
    topicId: candidate.topicId ?? "topic-unknown",
    topicLabel: candidate.topicLabel ?? "General topic",
    heuristicSignalScore: candidate.heuristicSignalScore ?? 50,
    topicCoherenceScore: candidate.topicCoherenceScore ?? 50,
    boundaryQualityScore: candidate.boundaryQualityScore ?? 50,
    boundaryQualityReason: candidate.boundaryQualityReason ?? "Sentence boundaries are intact.",
    boundaryChanges: candidate.boundaryChanges ?? [],
    ...(candidate.standaloneCheck ? { standaloneCheck: candidate.standaloneCheck } : {}),
    ruleStandalone: candidate.ruleStandalone ?? true,
    embedding: candidate.embedding ?? Array.from({ length: 384 }, () => 0),
    contentHash,
    score: scored.finalScore ?? result.score,
    breakdown: result.breakdown,
    scoringMode: result.scoringMode,
    scoringProvider: result.scoringProvider ?? (result.scoringMode === "Heuristic-scored" ? "Heuristic" : "Ollama"),
    ...(result.rankingBreakdown ? { rankingBreakdown: result.rankingBreakdown } : {}),
    ...(scored.factorBreakdown ? { factorBreakdown: scored.factorBreakdown } : {}),
    selectedForRendering: false,
    isStaged: true
  } satisfies Partial<WorkerClip>);
}

export async function stageThenSwap<T>(
  stage: () => Promise<T>,
  swap: (staged: T) => Promise<void>,
  rollback: (staged: T) => Promise<void>
) {
  const staged = await stage();
  try {
    await swap(staged);
  } catch (error) {
    await rollback(staged);
    throw error;
  }
}

export async function replaceVideoClips(videoId: Types.ObjectId, documents: ReturnType<typeof createStagedClipDocument>[]) {
  await validateStagedClipDocuments(documents);
  const ids = documents.map((document) => document._id);
  await stageThenSwap(
    async () => {
      try {
        for (const document of documents) await document.save();
        return ids;
      } catch (error) {
        await WorkerClipModel.deleteMany({ _id: { $in: ids } });
        throw error;
      }
    },
    async (stagedIds) => {
      if (stagedIds.length > 0) {
        const activated = await WorkerClipModel.updateMany(
          { _id: { $in: stagedIds }, isStaged: true },
          { $set: { isStaged: false } }
        );
        if (activated.modifiedCount !== stagedIds.length) {
          throw new Error("Could not activate all validated clip candidates");
        }
      }
      await WorkerClipModel.deleteMany({ videoId, _id: { $nin: stagedIds } });
    },
    async (stagedIds) => {
      await WorkerClipModel.deleteMany({ _id: { $in: stagedIds } });
    }
  );
}

export async function validateStagedClipDocuments(documents: ReturnType<typeof createStagedClipDocument>[]) {
  await Promise.all(documents.map((document) => document.validate()));
}
