import { describe, expect, it } from "vitest";
import { escapeAssText, generateAssSubtitles } from "./ass.js";

describe("ASS subtitle generation", () => {
  it("offsets subtitle timestamps to the clip start", () => {
    const ass = generateAssSubtitles([
      { text: " Hello", start: 10.25, end: 10.5 },
      { text: " world.", start: 10.55, end: 11 }
    ], 10, 15);

    expect(ass).toContain("Dialogue: 0,0:00:00.17,0:00:01.00,Default");
    expect(ass).toContain("Hello world.");
  });

  it("groups subtitles into phrase-aware chunks with no more than six words", () => {
    const words = Array.from({ length: 10 }, (_, index) => ({
      text: `${index === 0 ? "" : " "}word${index + 1}`,
      start: index * 0.3,
      end: index * 0.3 + 0.2
    }));
    const dialogue = generateAssSubtitles(words, 0, 5)
      .split("\n")
      .filter((line) => line.startsWith("Dialogue:"));

    expect(dialogue).toHaveLength(2);
    expect(dialogue.map((line) => line.split(",").at(-1)?.trim().split(/\s+/).length)).toEqual([6, 4]);
  });

  it("escapes override braces, backslashes, and line breaks", () => {
    expect(escapeAssText("Hi {\\b1}!\nNext")).toBe("Hi \\{\\\\b1\\}! Next");
  });

  it("does not create empty glyph text for Hindi caption words", () => {
    const ass = generateAssSubtitles([
      { text: " नमस्ते", start: 1, end: 1.4 },
      { text: " दुनिया", start: 1.5, end: 1.9 }
    ], 1, 3);

    expect(ass).toContain("Style: Default,Noto Sans");
    expect(ass).toContain("नमस्ते दुनिया");
  });
});
