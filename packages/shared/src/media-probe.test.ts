import { describe, expect, it } from "vitest";
import { enforceDurationLimit, MediaProbeError } from "./media-probe.js";

describe("enforceDurationLimit", () => {
  it("accepts durations at or below the configured maximum", () => {
    expect(() => enforceDurationLimit(600, 3_600)).not.toThrow();
    expect(() => enforceDurationLimit(3_600, 3_600)).not.toThrow();
  });

  it("rejects over-limit and unknown durations distinctly", () => {
    expect(() => enforceDurationLimit(3_601, 3_600)).toThrow(/exceeds the configured 3600-second limit/);
    expect(() => enforceDurationLimit(Number.NaN, 3_600)).toThrow(MediaProbeError);
    expect(() => enforceDurationLimit(0, 3_600)).toThrow(/duration could not be determined/);
  });
});
