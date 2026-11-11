import { describe, expect, it } from "vitest";
import { clipFunnelReportSchema } from "@clipforge/shared/clip-funnel";
import { createClipFunnelReport } from "./funnel.js";

describe("candidate funnel report", () => {
  it("stores counts, per-candidate removal reasons, and the active config thresholds", () => {
    const report = createClipFunnelReport({
      attemptedCount: 170,
      generatedCount: 97,
      candidatePoolCount: 60,
      scoredCount: 15,
      selectedCount: 3
    }, [
      { start: 5, end: 35, reason: "near-duplicate", detail: "Transcript similarity exceeded the configured threshold." },
      { start: 35, end: 65, reason: "duplicate-window", detail: "Repeated window was discarded." },
      { start: 45, end: 75, reason: "low-score", detail: "Final score was below the configured minimum." },
      { start: 90, end: 120, reason: "mmr-diversity", detail: "The MMR selection favored another topic." }
    ]);
    const parsed = clipFunnelReportSchema.safeParse(report);

    expect(parsed.success).toBe(true);
    expect(report.attemptedCount).toBe(170);
    expect(report.generatedCount).toBe(97);
    expect(report.candidatePoolCount).toBe(60);
    expect(report.scoredCount).toBe(15);
    expect(report.selectedCount).toBe(3);
    expect(report.removalCounts["near-duplicate"]).toBe(1);
    expect(report.removalCounts["duplicate-window"]).toBe(1);
    expect(report.removals.map(({ start, reason }) => [start, reason])).toEqual([
      [5, "near-duplicate"],
      [35, "duplicate-window"],
      [45, "low-score"],
      [90, "mmr-diversity"]
    ]);
    expect(report.thresholds).toHaveProperty("minimumFinalScore");
    expect(report.thresholds).toHaveProperty("duplicateOverlapFraction");
    expect(report.thresholds).toHaveProperty("rankingWeights");
  });
});
