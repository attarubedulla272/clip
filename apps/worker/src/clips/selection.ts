import { CLIP_DETECTION_CONFIG } from "./ranking-config.js";
import { cosineSimilarity } from "./topics.js";

export interface RankedCandidate {
  score: number;
  start: number;
  topicId: string;
  embedding: number[];
}

export function removeNearDuplicateCandidates<T extends RankedCandidate>(
  candidates: T[],
  threshold = CLIP_DETECTION_CONFIG.duplicateSimilarityThreshold
) {
  const ordered = [...candidates].sort((left, right) =>
    right.score - left.score || left.start - right.start
  );
  const selected: T[] = [];
  for (const candidate of ordered) {
    const duplicate = selected.some((existing) =>
      cosineSimilarity(candidate.embedding, existing.embedding) >= threshold
    );
    if (!duplicate) selected.push(candidate);
  }
  return selected;
}

export function selectCandidatesByMmr<T extends RankedCandidate>(
  candidates: T[],
  maximum = CLIP_DETECTION_CONFIG.maximumSelectedCandidates,
  lambda = CLIP_DETECTION_CONFIG.mmrLambda
) {
  const remaining = [...candidates];
  const selected: T[] = [];
  while (remaining.length > 0 && selected.length < maximum) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const relevance = candidate.score / 100;
      const redundancy = selected.length === 0 ? 0 : Math.max(...selected.map((existing) => {
        const similarity = cosineSimilarity(candidate.embedding, existing.embedding);
        return candidate.topicId === existing.topicId
          ? Math.max(similarity, CLIP_DETECTION_CONFIG.sameTopicSimilarity)
          : similarity;
      }));
      const value = lambda * relevance - (1 - lambda) * redundancy;
      if (value > bestValue ||
        (value === bestValue && candidate.start < remaining[bestIndex]!.start)) {
        bestValue = value;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }
  return selected;
}
