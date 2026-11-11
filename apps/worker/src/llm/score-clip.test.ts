import { describe, expect, it } from "vitest";
import type { ClipScoreInput, ClipScoreResult } from "@clipforge/shared/clip-scoring";
import type { LlmProvider } from "./llm-provider.js";
import { requestValidatedScore, scoreClipWithFallback } from "./score-clip.js";

const validJson = JSON.stringify({
  score: 73,
  breakdown: {
    hookStrength: { score: 70, reason: "A direct question opens the passage." },
    emotionalPeak: { score: 75, reason: "An emphatic line adds energy." },
    standaloneClarity: { score: 72, reason: "The idea is introduced clearly." },
    pacing: { score: 74, reason: "The passage has a lively pace." },
    payoff: { score: 74, reason: "The final sentence resolves the idea." }
  }
});

const input: ClipScoreInput = {
  transcriptText: "Why does this matter? This is a useful idea!",
  signalsFound: ["Question", "Exclamation", "Audio energy peak"],
  durationSeconds: 30
};

function createProvider(responses: Array<string | Error>): LlmProvider & { calls: number } {
  let index = 0;
  return {
    modelName: "llama3.2:3b",
    calls: 0,
    async generateScoreJson() {
      this.calls += 1;
      const response = responses[index++] ?? responses.at(-1)!;
      if (response instanceof Error) throw response;
      return response;
    }
  };
}

function createCache() {
  const values = new Map<string, ClipScoreResult>();
  return {
    calls: 0,
    async get(hash: string) {
      this.calls += 1;
      return values.get(hash);
    },
    async set(hash: string, result: ClipScoreResult) {
      const existing = values.get(hash);
      if (existing) return existing;
      values.set(hash, result);
      return result;
    }
  };
}

describe("requestValidatedScore", () => {
  it("retries invalid JSON up to two times and accepts the next valid response", async () => {
    const provider = createProvider(["not json", validJson]);
    const result = await requestValidatedScore(provider, input);

    expect(result.score).toBe(73);
    expect(provider.calls).toBe(2);
  });

  it("makes no more than two retries when every response is invalid", async () => {
    const provider = createProvider(["{}", "{}", "{}"]);
    await expect(requestValidatedScore(provider, input)).rejects.toThrow(/invalid score data/);
    expect(provider.calls).toBe(3);
  });
});

describe("scoreClipWithFallback", () => {
  it("uses a heuristic score when the provider is unavailable", async () => {
    const provider = createProvider([new Error("Ollama is offline")]);
    const result = await scoreClipWithFallback(input, provider, createCache());

    expect(result.result.scoringMode).toBe("Heuristic-scored");
    expect(result.result.breakdown.hookStrength.reason).toContain("question");
  });

  it("uses a heuristic score when Ollama keeps returning invalid JSON", async () => {
    const provider = createProvider(["not json", "still not json", "also not json"]);
    const result = await scoreClipWithFallback(input, provider, createCache());

    expect(result.result.scoringMode).toBe("Heuristic-scored");
    expect(provider.calls).toBe(3);
  });

  it("caches a score by content hash so an identical clip is not requested twice", async () => {
    const provider = createProvider([validJson]);
    const cache = createCache();
    const first = await scoreClipWithFallback(input, provider, cache);
    const second = await scoreClipWithFallback(input, provider, cache);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(provider.calls).toBe(1);
  });
});
