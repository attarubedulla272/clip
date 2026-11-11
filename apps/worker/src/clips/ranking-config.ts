export const CLIP_RANKING_WEIGHTS = {
  llmHighlight: 0.30,
  speechPace: 0.12,
  audioEnergy: 0.12,
  questionsPauses: 0.10,
  hookStrength: 0.12,
  topicCoherence: 0.10,
  boundaryQuality: 0.08,
  novelty: 0.06
} as const;

export const CLIP_DETECTION_CONFIG = {
  maximumCandidatesBeforeSelection: 60,
  maximumCandidatesForLlm: 15,
  maximumSelectedCandidates: 8,
  candidateStartStepSeconds: 8,
  candidateTargetDurationsSeconds: [20, 30, 40, 50, 60],
  minimumDurationSeconds: 20,
  maximumDurationSeconds: 60,
  topicWindowSentences: 3,
  topicDepthSensitivity: 0.6,
  topicSimilarityThreshold: 0.58,
  topicBoundaryDropThreshold: 0.18,
  minimumTopicSentences: 3,
  minimumTopicSeconds: 30,
  maximumTopicSeconds: 180,
  targetTopicSeconds: 90,
  duplicateSimilarityThreshold: 0.92,
  duplicateOverlapFraction: 0.45,
  mmrLambda: 0.72,
  minimumFinalScore: 35,
  sameTopicSimilarity: 0.85,
  maximumStartExtensionSentences: 3,
  minimumFinalClipSeconds: 15,
  maximumFinalClipSeconds: 60,
  maximumStandaloneAdjustmentSeconds: 15,
  leadingFillerWords: ["yeah", "right", "okay", "ok", "um", "uh", "umm", "erm", "so"],
  fillerWordsWithoutComma: ["um", "uh", "umm", "erm"],
  unresolvedOpeningWords: ["this", "that", "so", "and", "but"],
  trailingWeakEndingWords: ["and", "but", "so", "because", "to", "with", "for", "that", "which", "or"]
} as const;

export function rankingWeightsTotal() {
  return Object.values(CLIP_RANKING_WEIGHTS).reduce((total, weight) => total + weight, 0);
}
