import { describe, expect, it } from "vitest";
import {
  chunkCaptionWords,
  cleanCaptionFillers,
  generateAssSubtitles,
  getCaptionPreviewRange,
  normalizeCaptionTimings,
  selectEmphasisWordIndexes
} from "./captions.js";
import type { TimedTranscriptWord } from "@clipforge/shared/clip-trim";

function wordsFrom(texts: string[], start = 10, step = 0.3): TimedTranscriptWord[] {
  return texts.map((text, index) => ({
    text: `${index === 0 ? "" : " "}${text}`,
    start: start + index * step,
    end: start + index * step + 0.2
  }));
}

describe("caption intelligence", () => {
  it("limits style previews to exactly five seconds", () => {
    expect(getCaptionPreviewRange(12, 45)).toEqual({ start: 12, end: 17 });
    expect(getCaptionPreviewRange(12, 15)).toEqual({ start: 12, end: 15 });
  });

  it("emits karaoke highlight tags with times relative to clip start and a short pre-audio lead-in", () => {
    const ass = generateAssSubtitles(wordsFrom(["We", "create", "real", "change.", "Today", "matters."]), 10, 15, "karaoke");

    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:00.79,Default");
    expect(ass).toContain("Dialogue: 0,0:00:00.82,0:00:01.69,Default");
    expect(ass).toContain("{\\fad(70,0)");
    expect(ass).toContain("{\\kf20}");
    expect(ass).toContain("{\\kf20} change.");
    expect(ass).toContain("MarginV, Encoding");
    expect(ass).toContain(",430,1");
    const cleanAss = generateAssSubtitles(
      wordsFrom(["one", "two", "three", "four", "five", "six"]),
      10,
      15
    );
    expect(cleanAss).toContain("three\\N four");
  });

  it("keeps ASS escaping safe for override characters", () => {
    const ass = generateAssSubtitles(wordsFrom(["One", "{\\b1}", "three", "four."]), 10, 15, "karaoke");
    expect(ass).toContain("\\{\\\\b1\\}");
  });

  it("breaks phrase chunks at pauses and punctuation while limiting chunks to 3-6 words", () => {
    const words = wordsFrom(["One", "two", "three,", "four", "five", "six", "seven.", "eight", "nine", "ten"]);
    words[4] = { ...words[4]!, start: words[4]!.start + 0.7, end: words[4]!.end + 0.7 };
    const chunks = chunkCaptionWords(words);

    expect(chunks.map(({ words: chunk }) => chunk.length)).toEqual([3, 4, 3]);
    expect(chunks[0]!.words.at(-1)?.text).toContain(",");
  });

  it.each([
    [7, [4, 3]],
    [8, [5, 3]]
  ])("balances a short final phrase in a %i-word caption", (count, expectedLengths) => {
    const words = wordsFrom(Array.from({ length: count }, (_, index) => `word${index + 1}`));
    expect(chunkCaptionWords(words).map((chunk) => chunk.words.length)).toEqual(expectedLengths);
  });

  it("emphasizes no more than 15 percent of caption words", () => {
    const words = wordsFrom([
      "We", "create", "change", "life", "with", "gratitude", "today", "and", "improve",
      "health", "by", "50%", "then", "build", "success", "again", "tomorrow", "together",
      "with", "a", "result"
    ]);
    const indexes = selectEmphasisWordIndexes(words);
    expect(indexes.size).toBeLessThanOrEqual(Math.floor(words.length * 0.15));
    expect(indexes.size).toBeGreaterThan(0);
    expect(generateAssSubtitles(words, 10, 20, "bold-pop")).toContain("\\fscx118");
  });

  it("removes filler and immediate repeated words only from caption text without changing retained timings", () => {
    const words = wordsFrom(["um", "we", "we", "uh", "create", "change."]);
    const cleaned = cleanCaptionFillers(words);

    expect(cleaned.map(({ text }) => text.trim())).toEqual(["we", "create", "change."]);
    expect(cleaned.map(({ start, end }) => [start, end])).toEqual([
      [words[1]!.start, words[1]!.end],
      [words[4]!.start, words[4]!.end],
      [words[5]!.start, words[5]!.end]
    ]);
    const ass = generateAssSubtitles(words, 10, 15, "clean", true);
    expect(ass).not.toContain(" um");
    expect(ass).toContain("we create change.");
  });

  it("enforces minimum word duration and removes overlapping or unusable timestamps", () => {
    const words: TimedTranscriptWord[] = [
      { text: " one", start: 0, end: 0.02 },
      { text: " two", start: 0.04, end: 0.3 },
      { text: " three", start: 0.25, end: 0.26 },
      { text: " four", start: 0.4, end: 0.8 }
    ];
    const normalized = normalizeCaptionTimings(words, 0, 1);

    expect(normalized.map(({ text }) => text.trim())).toEqual(["two", "four"]);
    expect(normalized.every(({ end, start }) => end - start >= 0.08)).toBe(true);
    expect(normalized.slice(1).every((word, index) => word.start >= normalized[index]!.end)).toBe(true);
  });

  it("renders Hindi and Telugu script text in the ASS output without splitting characters", () => {
    const ass = generateAssSubtitles(wordsFrom(["नमस्ते", "दुनिया।", "తెలుగు", "పరీక్ష."]), 10, 15);
    expect(ass).toContain("नमस्ते दुनिया।");
    expect(ass).toContain("తెలుగు\\N పరీక్ష.");
    expect(ass).toContain("Noto Sans");
  });
});
