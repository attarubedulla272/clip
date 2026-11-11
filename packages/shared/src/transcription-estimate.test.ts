import { describe, expect, it } from "vitest";
import { estimateTranscriptionSeconds } from "./transcription-estimate.js";

describe("estimateTranscriptionSeconds", () => {
  it("uses the measured balanced-model ratio and a lower estimate for fast mode", () => {
    expect(estimateTranscriptionSeconds(120, "balanced")).toBe(81);
    expect(estimateTranscriptionSeconds(120, "fast")).toBe(48);
  });

  it("keeps short clips from reporting a zero-minute estimate", () => {
    expect(estimateTranscriptionSeconds(10, "fast")).toBe(30);
  });
});
