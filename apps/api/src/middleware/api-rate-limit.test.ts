import { describe, expect, it } from "vitest";
import { shouldSkipApiRateLimit } from "./api-rate-limit.js";

describe("shouldSkipApiRateLimit", () => {
  it("does not charge safe read requests against the mutation budget", () => {
    expect(shouldSkipApiRateLimit("GET")).toBe(true);
    expect(shouldSkipApiRateLimit("HEAD")).toBe(true);
  });

  it("continues to rate-limit state-changing requests", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(shouldSkipApiRateLimit(method)).toBe(false);
    }
  });
});
