import { describe, expect, it } from "vitest";
import { mergeChunkTranscripts } from "./chunks.js";

describe("mergeChunkTranscripts", () => {
  it("adds each chunk offset to word and segment timestamps and sorts the results", () => {
    const transcript = mergeChunkTranscripts([
      {
        offsetSeconds: 30,
        words: [{ text: " world", start: 0.2, end: 0.8 }],
        segments: [{ start: 0.2, end: 0.8, text: "world" }]
      },
      {
        offsetSeconds: 0,
        words: [{ text: "Hello", start: 0.1, end: 0.5 }],
        segments: [{ start: 0.1, end: 0.5, text: "Hello" }]
      }
    ]);

    expect(transcript.words).toEqual([
      { text: "Hello", start: 0.1, end: 0.5 },
      { text: " world", start: 30.2, end: 30.8 }
    ]);
    expect(transcript.segments.map(({ start, end }) => [start, end])).toEqual([[0.1, 0.5], [30.2, 30.8]]);
  });
});
