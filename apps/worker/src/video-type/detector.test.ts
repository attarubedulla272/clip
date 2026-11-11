import { describe, expect, it } from "vitest";
import { HeuristicVideoTypeDetector } from "./detector.js";

describe("HeuristicVideoTypeDetector", () => {
  it("recognizes tutorial cue words and reports measurable heuristics", () => {
    const result = new HeuristicVideoTypeDetector().detect({
      durationSeconds: 120,
      segments: [
        { start: 0, end: 4, text: "First, open the editor and click the project menu." },
        { start: 6, end: 10, text: "Next, install the package and follow this step." },
        { start: 12, end: 16, text: "Finally, export the result." }
      ]
    });

    expect(result.type).toBe("tutorial");
    expect(result.speechDensityWordsPerMinute).toBeGreaterThan(0);
    expect(result.questionRatio).toBe(0);
  });

  it("uses question ratio and interview phrases as heuristic evidence", () => {
    const result = new HeuristicVideoTypeDetector().detect({
      durationSeconds: 30,
      segments: [
        { start: 0, end: 4, text: "Tell me about your experience?" },
        { start: 5, end: 9, text: "How did you get started?" },
        { start: 10, end: 15, text: "What do you think about that?" }
      ]
    });

    expect(result.type).toBe("interview");
    expect(result.questionRatio).toBe(1);
  });
});
