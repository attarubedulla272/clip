import { describe, expect, it } from "vitest";
import {
  deriveTrendQueries,
  titleWordOverlap,
  TREND_CONFIG,
  trendSignalsSchema
} from "./clip-metadata.js";

describe("trend-informed metadata", () => {
  it("derives a small set of niche queries from clip and topic text", () => {
    const queries = deriveTrendQueries(
      "React server components improve rendering and loading patterns",
      "React performance",
      "tutorial",
      3
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(3);
    expect(queries.join(" ").toLowerCase()).toContain("react");
  });

  it("uses the configurable title overlap threshold to reject close copies", () => {
    const overlap = titleWordOverlap(
      "React server components explained",
      ["React server components explained in detail"]
    );
    expect(overlap).toBeGreaterThanOrEqual(TREND_CONFIG.titleOverlapThreshold);
  });

  it("accepts offline trend signals and reports quota remaining without a key", () => {
    const parsed = trendSignalsSchema.parse({
      mode: "offline",
      badge: "Trend data: offline",
      queries: ["React server components"],
      samples: [],
      topKeywords: ["react", "components"],
      commonHashtags: ["#react"],
      fetchedAt: new Date().toISOString(),
      regionCode: "IN",
      relevanceLanguage: "en",
      quotaUsedToday: 0,
      quotaRemaining: 8000,
      fallbackReason: "YOUTUBE_API_KEY is not configured"
    });
    expect(parsed.mode).toBe("offline");
    expect(parsed.badge).toBe("Trend data: offline");
  });
});
