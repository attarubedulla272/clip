export type ModelSpeed = "fast" | "balanced";

export function estimateTranscriptionSeconds(durationSeconds: number, modelSpeed: ModelSpeed) {
  const measuredBalancedSecondsPerVideoSecond = 81 / 120;
  const estimatedFastSecondsPerVideoSecond = 0.4;
  const multiplier = modelSpeed === "balanced"
    ? measuredBalancedSecondsPerVideoSecond
    : estimatedFastSecondsPerVideoSecond;
  return Math.max(30, Math.ceil(durationSeconds * multiplier));
}
