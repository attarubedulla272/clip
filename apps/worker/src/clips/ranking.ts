import type { ClipFactorBreakdown, ClipFactorName, ClipScoreResult } from "@clipforge/shared/clip-scoring";
import { CLIP_DETECTION_CONFIG, CLIP_RANKING_WEIGHTS } from "./ranking-config.js";
import { cosineSimilarity } from "./topics.js";
import type { ClipCandidate } from "./shortlist.js";
import type { ClipFunnelRemoval } from "@clipforge/shared/clip-funnel";

export interface RankedClipCandidate {
  candidate: ClipCandidate;
  result: ClipScoreResult;
  contentHash: string;
  cached: boolean;
  score: number;
  factorBreakdown: ClipFactorBreakdown;
}

type CheapFactorName = Exclude<ClipFactorName, "llmHighlight" | "novelty">;

function percentileScores(values: number[]) {
  if (values.length < 2 || Math.max(...values) === Math.min(...values)) {
    return values.map(() => 50);
  }
  const sorted = [...values].sort((left, right) => left - right);
  return values.map((value) => {
    const first = sorted.findIndex((entry) => entry === value);
    let last = first;
    for (let index = first + 1; index < sorted.length && sorted[index] === value; index += 1) last = index;
    const rank = (first + last) / 2;
    return Math.max(0, Math.min(100, Math.round(rank / (sorted.length - 1) * 100)));
  });
}

function rawCheapFactors(candidate: ClipCandidate): Record<CheapFactorName, number> {
  return {
    speechPace: candidate.speechPaceScore ?? candidate.heuristicSignalScore ?? 50,
    audioEnergy: candidate.audioEnergyScore ?? 45,
    questionsPauses: candidate.questionsPausesScore ?? 45,
    hookStrength: candidate.hookStrengthScore ?? 50,
    topicCoherence: candidate.topicCoherenceScore ?? 50,
    boundaryQuality: candidate.boundaryQualityScore ?? 50
  };
}

const cheapFactorNames: CheapFactorName[] = [
  "speechPace",
  "audioEnergy",
  "questionsPauses",
  "hookStrength",
  "topicCoherence",
  "boundaryQuality"
];

export function cheapCandidateScores(candidates: ClipCandidate[]) {
  const raw = candidates.map(rawCheapFactors);
  const normalized = Object.fromEntries(cheapFactorNames.map((factor) => [
    factor,
    percentileScores(raw.map((row) => row[factor]))
  ])) as Record<CheapFactorName, number[]>;
  return candidates.map((candidate, index) => {
    const totalWeight = cheapFactorNames.reduce((sum, factor) => sum + CLIP_RANKING_WEIGHTS[factor], 0);
    const score = cheapFactorNames.reduce((sum, factor) =>
      sum + (normalized[factor][index] ?? 50) * CLIP_RANKING_WEIGHTS[factor], 0
    ) / totalWeight;
    return { candidate, score };
  }).sort((left, right) => right.score - left.score || left.candidate.start - right.candidate.start);
}

function textSimilarity(left: ClipCandidate, right: ClipCandidate) {
  const leftEmbedding = left.embedding ?? [];
  const rightEmbedding = right.embedding ?? [];
  if (leftEmbedding.length > 0 && leftEmbedding.length === rightEmbedding.length &&
    (leftEmbedding.some((value) => value !== 0) || rightEmbedding.some((value) => value !== 0))) {
    return Math.max(0, cosineSimilarity(leftEmbedding, rightEmbedding));
  }
  const leftWords = new Set(left.transcriptText.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]{3,}/gu) ?? []);
  const rightWords = new Set(right.transcriptText.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]{3,}/gu) ?? []);
  const union = new Set([...leftWords, ...rightWords]).size;
  if (union === 0) return 0;
  let intersection = 0;
  for (const word of leftWords) if (rightWords.has(word)) intersection += 1;
  return intersection / union;
}

export function candidateTextSimilarity(left: ClipCandidate, right: ClipCandidate) {
  return textSimilarity(left, right);
}

function overlapFraction(left: ClipCandidate, right: ClipCandidate) {
  const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
  return overlap / Math.max(0.1, Math.min(left.end - left.start, right.end - right.start));
}

function noveltyScores(candidates: ClipCandidate[]) {
  return candidates.map((candidate, index) => {
    let maximumSimilarity = 0;
    for (let otherIndex = 0; otherIndex < candidates.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      maximumSimilarity = Math.max(maximumSimilarity, textSimilarity(candidate, candidates[otherIndex]!));
    }
    return Math.round((1 - maximumSimilarity) * 100);
  });
}

export function rankScoredCandidates(
  candidates: Array<{ candidate: ClipCandidate; result: ClipScoreResult; contentHash: string; cached: boolean }>
): RankedClipCandidate[] {
  const rawRows = candidates.map(({ candidate, result }) => ({
    llmHighlight: result.score,
    ...rawCheapFactors(candidate),
    novelty: 0
  }));
  const novelty = noveltyScores(candidates.map(({ candidate }) => candidate));
  rawRows.forEach((row, index) => { row.novelty = novelty[index] ?? 50; });
  const normalized = Object.fromEntries(
    (Object.keys(CLIP_RANKING_WEIGHTS) as ClipFactorName[]).map((factor) => [
      factor,
      percentileScores(rawRows.map((row) => row[factor]))
    ])
  ) as Record<ClipFactorName, number[]>;
  return candidates.map((entry, index) => {
    const candidate = entry.candidate;
    const factors = Object.fromEntries(
      (Object.keys(CLIP_RANKING_WEIGHTS) as ClipFactorName[]).map((name) => {
        const score = normalized[name][index] ?? 50;
        const weight = CLIP_RANKING_WEIGHTS[name];
        const reason = name === "llmHighlight"
          ? `${entry.result.scoringMode} highlight assessment.`
          : name === "speechPace" ? `${Math.round(candidate.speechPaceScore ?? candidate.heuristicSignalScore ?? 50)} raw pace signal.`
            : name === "audioEnergy" ? `${Math.round(candidate.audioEnergyScore ?? 45)} raw audio-energy signal.`
              : name === "questionsPauses" ? `${Math.round(candidate.questionsPausesScore ?? 45)} raw question and pause signal.`
                : name === "hookStrength" ? `${Math.round(candidate.hookStrengthScore ?? 50)} raw first-five-seconds hook signal.`
                  : name === "topicCoherence" ? `Semantic similarity to topic: ${candidate.topicLabel ?? "unknown"}.`
                    : name === "boundaryQuality" ? candidate.boundaryQualityReason ?? "Sentence-bounded candidate."
                      : `Novelty relative to other candidates: ${novelty[index] ?? 50}.`;
        return [name, { score, weight, contribution: score * weight, reason: reason.slice(0, 200) }];
      })
    ) as ClipFactorBreakdown;
    const score = Math.round(Object.values(factors).reduce((sum, factor) => sum + factor.contribution, 0));
    return { ...entry, score, factorBreakdown: factors };
  }).sort((left, right) => right.score - left.score || left.candidate.start - right.candidate.start);
}

export function removeNearDuplicateCandidates(candidates: RankedClipCandidate[]) {
  return removeNearDuplicateCandidatesWithDiagnostics(candidates).selected;
}

function removeNearDuplicateCandidatesWithDiagnostics(candidates: RankedClipCandidate[]) {
  const selected: RankedClipCandidate[] = [];
  const removals: ClipFunnelRemoval[] = [];
  for (const candidate of [...candidates].sort((left, right) => right.score - left.score)) {
    const overlapDuplicate = selected.find((higherRanked) =>
      overlapFraction(candidate.candidate, higherRanked.candidate) >= CLIP_DETECTION_CONFIG.duplicateOverlapFraction
    );
    if (overlapDuplicate) {
      removals.push({
        start: candidate.candidate.start,
        end: candidate.candidate.end,
        reason: "overlap",
        detail: `Overlaps a higher-ranked clip by at least ${Math.round(CLIP_DETECTION_CONFIG.duplicateOverlapFraction * 100)}% of the shorter clip.`
      });
      continue;
    }
    const textDuplicate = selected.find((higherRanked) =>
      textSimilarity(candidate.candidate, higherRanked.candidate) >= CLIP_DETECTION_CONFIG.duplicateSimilarityThreshold
    );
    if (textDuplicate) {
      removals.push({
        start: candidate.candidate.start,
        end: candidate.candidate.end,
        reason: "near-duplicate",
        detail: `Transcript similarity reached the ${CLIP_DETECTION_CONFIG.duplicateSimilarityThreshold.toFixed(2)} duplicate threshold.`
      });
      continue;
    }
    selected.push(candidate);
  }
  return { selected, removals };
}

export function selectDiverseCandidates(candidates: RankedClipCandidate[]) {
  return selectDiverseCandidatesWithDiagnostics(candidates).selected;
}

export function selectDiverseCandidatesWithDiagnostics(candidates: RankedClipCandidate[]) {
  const deduplicated = removeNearDuplicateCandidatesWithDiagnostics(candidates);
  const removals = [...deduplicated.removals];
  const pool = deduplicated.selected.filter((candidate) => {
    if (candidate.score >= CLIP_DETECTION_CONFIG.minimumFinalScore) return true;
    removals.push({
      start: candidate.candidate.start,
      end: candidate.candidate.end,
      reason: "low-score",
      detail: `Final score ${candidate.score} is below the ${CLIP_DETECTION_CONFIG.minimumFinalScore} minimum.`
    });
    return false;
  });
  const selected: RankedClipCandidate[] = [];
  while (pool.length > 0 && selected.length < CLIP_DETECTION_CONFIG.maximumSelectedCandidates) {
    let bestIndex = -1;
    let bestMmr = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < pool.length; index += 1) {
      const current = pool[index]!;
      if (selected.some((picked) => overlapFraction(current.candidate, picked.candidate) > 0)) continue;
      const similarity = selected.reduce((maximum, picked) => {
        const semantic = textSimilarity(current.candidate, picked.candidate);
        const topicPenalty = current.candidate.topicId && current.candidate.topicId === picked.candidate.topicId ? 0.85 : 0;
        return Math.max(maximum, semantic, topicPenalty);
      }, 0);
      const mmr = CLIP_DETECTION_CONFIG.mmrLambda * current.score / 100 -
        (1 - CLIP_DETECTION_CONFIG.mmrLambda) * similarity;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    selected.push(pool.splice(bestIndex, 1)[0]!);
  }
  for (const candidate of pool) {
    const overlaps = selected.some((picked) => overlapFraction(candidate.candidate, picked.candidate) > 0);
    removals.push({
      start: candidate.candidate.start,
      end: candidate.candidate.end,
      reason: overlaps ? "overlap" : "mmr-diversity",
      detail: overlaps
        ? "MMR would not choose a clip covering any part of an already selected moment."
        : `MMR stopped after selecting ${selected.length} clips; this candidate ranked below the diversity/relevance cutoff or maximum selection count.`
    });
  }
  return { selected, removals };
}

export function normalizeFactorScores(values: number[]) {
  return percentileScores(values);
}

export function factorWeightsTotal() {
  return Object.values(CLIP_RANKING_WEIGHTS).reduce((total, weight) => total + weight, 0);
}
