import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Clip } from "./clip.js";

function makeClip(overrides: Record<string, unknown> = {}) {
  const score = { score: 70, reason: "Supported by the transcript." };
  return new Clip({
    videoId: new Types.ObjectId(),
    start: 5,
    end: 25,
    transcriptText: "A useful example from the saved transcript.",
    signalsFound: [],
    reason: "Clear standalone thought.",
    topicId: "topic-1",
    topicLabel: "Useful example",
    contentHash: "caption-test-hash",
    score: 75,
    breakdown: {
      hookStrength: score,
      emotionalPeak: score,
      standaloneClarity: score,
      pacing: score,
      payoff: score
    },
    scoringMode: "Heuristic-scored",
    selectedForRendering: false,
    ...overrides
  });
}

describe("Clip caption settings Mongoose validation", () => {
  it("validates the real Clip model and applies safe caption defaults for existing clip records", async () => {
    const clip = makeClip();

    await expect(clip.validate()).resolves.toBeUndefined();
    expect(clip.captionStyle).toBe("clean");
    expect(clip.cleanupCaptionFillers).toBe(true);
  });

  it.each(["clean", "karaoke", "bold-pop"] as const)("accepts the %s caption preset", async (captionStyle) => {
    const clip = makeClip({ captionStyle, cleanupCaptionFillers: false });

    await expect(clip.validate()).resolves.toBeUndefined();
    expect(clip.captionStyle).toBe(captionStyle);
    expect(clip.cleanupCaptionFillers).toBe(false);
  });

  it("rejects unknown caption presets", async () => {
    const clip = makeClip({ captionStyle: "sparkle" });
    await expect(clip.validate()).rejects.toMatchObject({
      errors: { captionStyle: expect.anything() }
    });
  });
});
