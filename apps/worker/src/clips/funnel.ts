import {
  clipFunnelRemovalReasonSchema,
  type ClipFunnelRemoval,
  type ClipFunnelReport
} from "@clipforge/shared/clip-funnel";
import { CLIP_DETECTION_CONFIG, CLIP_RANKING_WEIGHTS } from "./ranking-config.js";

export function createClipFunnelReport(
  counts: {
    attemptedCount: number;
    generatedCount: number;
    candidatePoolCount: number;
    scoredCount: number;
    selectedCount: number;
  },
  removals: ClipFunnelRemoval[]
): ClipFunnelReport {
  const removalCounts = Object.fromEntries(
    clipFunnelRemovalReasonSchema.options.map((reason) => [reason, 0])
  ) as Record<ClipFunnelRemoval["reason"], number>;
  for (const removal of removals) removalCounts[removal.reason] += 1;
  return {
    ...counts,
    thresholds: {
      ...CLIP_DETECTION_CONFIG,
      rankingWeights: CLIP_RANKING_WEIGHTS
    },
    removalCounts,
    removals
  };
}
