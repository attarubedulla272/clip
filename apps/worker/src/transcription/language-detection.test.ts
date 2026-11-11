import { describe, expect, it } from "vitest";
import { resolveDetectedLanguage } from "./runner.js";

describe("Whisper chunk language aggregation", () => {
  it("uses the duration-weighted majority instead of only the final chunk", () => {
    expect(resolveDetectedLanguage([
      { language: "en", durationSeconds: 30 },
      { language: "en", durationSeconds: 30 },
      { language: "hi", durationSeconds: 30 }
    ], "hi")).toBe("en");
  });

  it("falls back to the reported language when chunk evidence is unavailable", () => {
    expect(resolveDetectedLanguage([], "hi")).toBe("hi");
  });
});
