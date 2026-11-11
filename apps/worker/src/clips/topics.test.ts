import { describe, expect, it } from "vitest";
import { FastEmbedEmbeddingProvider } from "./embeddings.js";
import { fallbackHeuristicTopicSegments, segmentTopicsWithFallback, segmentTranscriptTopics, topicLabel } from "./topics.js";

function makeSentenceSet(count: number, startOffset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    start: startOffset + index * 12,
    end: startOffset + (index + 1) * 12,
    text: `Sentence ${index + 1} about the topic and the workflow for this clip. It keeps the transcript stable and useful for segmentation.`
  }));
}

function makeMixedEmbeddings(length: number, clusterCount: number) {
  const embeddings: number[][] = [];
  for (let index = 0; index < length; index += 1) {
    const cluster = index % Math.max(2, clusterCount);
    embeddings.push([
      cluster === 0 ? 1 : 0.1,
      cluster === 1 ? 1 : 0.1,
      cluster === 2 ? 1 : 0.1,
      cluster === 3 ? 1 : 0.1
    ]);
  }
  return embeddings;
}

describe("FastEmbedEmbeddingProvider", () => {
  it("reads the configured model and cache paths for a persistent local model cache", () => {
    const provider = new FastEmbedEmbeddingProvider({
      modelName: "sentence-transformers/example-model",
      cacheDir: "/models/fastembed"
    });

    expect(provider.modelName).toBe("sentence-transformers/example-model");
    expect(provider.cacheDir).toBe("/models/fastembed");
  });
});

describe("segmentTranscriptTopics", () => {
  it("filters spoken-English filler and Hindi stopwords from topic labels", () => {
    const text = "going know want like right yeah really just think thing और है हैं था थे की के का को से में पर यह वह वो हम आप मैं क्या तो भी एक नहीं camera lighting camera lighting framing framing";
    const label = topicLabel(text, 0, [text]);
    expect(label).toBe("camera · framing · lighting");
  });

  it("falls back to heuristic topics and a visible warning when embedding fails", async () => {
    const sentences = makeSentenceSet(12);
    const result = await segmentTopicsWithFallback(sentences, async () => {
      throw new Error("model cache is not writable");
    });

    expect(result.mode).toBe("basic");
    expect(result.warning).toBe("Topics: basic mode, embedding model unavailable");
    expect(result.embeddingError).toBe("model cache is not writable");
    expect(result.topics).toEqual(fallbackHeuristicTopicSegments(sentences));
  });

  it("creates separate topic sections when neighboring sentence windows diverge", () => {
    const sentences = [
      { start: 0, end: 6, text: "Dogs run in the park and chase tennis balls." },
      { start: 6, end: 12, text: "The dog keeps barking when the frisbee flies away." },
      { start: 12, end: 18, text: "The owner calls the dog back with a whistle." },
      { start: 18, end: 24, text: "The coffee shop fills up before the morning rush starts." },
      { start: 24, end: 30, text: "Baristas grind beans and pour fresh cups quickly." },
      { start: 30, end: 36, text: "A customer asks for a quiet table near the window." },
      { start: 36, end: 42, text: "The weather changes and rain begins by sunset." },
      { start: 42, end: 48, text: "Dark clouds move over the city and a storm starts." }
    ];
    const embeddings = [
      [1, 0], [1, 0.1], [1, 0.2],
      [0.05, 1], [0.1, 1], [0.08, 1],
      [1, 0.4], [1, 0.25]
    ];

    const result = segmentTranscriptTopics(sentences, embeddings);

    expect(result.topics.length).toBeGreaterThanOrEqual(2);
    expect(result.topics[0]?.start).toBe(0);
    expect(result.topics.every((segment) => segment.label.length > 0)).toBe(true);
    expect(result.topics.at(-1)?.end).toBeGreaterThan(result.topics[0]?.start ?? 0);
  });

  it("uses deeper topic boundaries on longer transcripts", () => {
    const shortSentences = makeSentenceSet(9, 0);
    const shortEmbeddings = makeMixedEmbeddings(shortSentences.length, 2);
    const longSentences = makeSentenceSet(28, 0);
    const longEmbeddings = makeMixedEmbeddings(longSentences.length, 4);

    const shortResult = segmentTranscriptTopics(shortSentences, shortEmbeddings);
    const longResult = segmentTranscriptTopics(longSentences, longEmbeddings);

    expect(longResult.topics.length).toBeGreaterThan(shortResult.topics.length);
    expect(longResult.boundaryDepthScores.length).toBeGreaterThan(0);
  });

  it("keeps segment lengths within the configured topic minimum and maximum bounds", () => {
    const sentences = makeSentenceSet(30, 0);
    const embeddings = makeMixedEmbeddings(sentences.length, 5);

    const result = segmentTranscriptTopics(sentences, embeddings);

    for (const segment of result.topics) {
      const duration = segment.end - segment.start;
      expect(duration).toBeGreaterThanOrEqual(30);
      expect(duration).toBeLessThanOrEqual(180);
    }
  });

  it("removes stopwords and contraction fragments from generated labels", () => {
    const sentences = [
      { start: 0, end: 10, text: "You're learning the method and the process step by step in the workshop." },
      { start: 10, end: 20, text: "This is your plan for the next week and the final review." }
    ];
    const embeddings = [
      [1, 0.1],
      [0.2, 1]
    ];

    const result = segmentTranscriptTopics(sentences, embeddings);

    expect(result.topics.every((segment) => !segment.label.toLowerCase().includes("re"))).toBe(true);
    expect(result.topics.every((segment) => !segment.label.toLowerCase().includes("you"))).toBe(true);
    expect(result.topics.every((segment) => segment.label.split(" · ").every((word) => word.length >= 3))).toBe(true);
  });

  it("can rerun topic segmentation on the saved transcript without re-transcribing", () => {
    const sentences = makeSentenceSet(18, 0);
    const embeddings = makeMixedEmbeddings(sentences.length, 3);

    const result = segmentTranscriptTopics(sentences, embeddings);

    expect(result.topics.length).toBeGreaterThan(1);
    expect(result.topics[0]?.contextBefore).toEqual([]);
    expect(result.topics.at(-1)?.contextAfter).toEqual([]);
  });
});
