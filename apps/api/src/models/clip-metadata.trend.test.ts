import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { ClipMetadata } from "./clip-metadata.js";

describe("real ClipMetadata Mongoose trend validation", () => {
  it("validates a metadata record with trend signals and no API key exposure", async () => {
    const document = new ClipMetadata({
      clipId: new Types.ObjectId(),
      videoId: new Types.ObjectId(),
      edited: false,
      language: "same",
      tone: "curious",
      includeOriginalCredit: false,
      useGemini: false,
      generationStatus: "idle",
      warnings: {},
      trendSignals: {
        mode: "online",
        badge: "Trend data: online",
        queries: ["React server components"],
        samples: [{
          title: "A public recent video title",
          url: "https://www.youtube.com/watch?v=abc123",
          videoId: "abc123",
          tags: ["react"],
          viewCount: 1000,
          publishedAt: new Date().toISOString()
        }],
        topKeywords: ["react", "components"],
        commonHashtags: ["#react"],
        fetchedAt: new Date().toISOString(),
        regionCode: "IN",
        relevanceLanguage: "en",
        quotaUsedToday: 101,
        quotaRemaining: 7999
      }
    });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(JSON.stringify(document.toObject())).not.toContain("AIza");
  });
});
