import { describe, expect, it } from "vitest";
import { nudgeClipEdge, parseTranscriptWords, snapToWordBoundary, type WordBoundary } from "@clipforge/shared/clip-trim";

const words: WordBoundary[] = [
  { start: 1, end: 1.3 },
  { start: 1.5, end: 1.8 },
  { start: 2, end: 2.4 },
  { start: 2.6, end: 3 }
];

describe("clip trim snapping", () => {
  it("skips zero-duration transcript tokens instead of treating them as word boundaries", () => {
    const parsed = parseTranscriptWords([
      { text: " hello", start: 1, end: 1.2 },
      { text: " world", start: 1.2, end: 1.2 }
    ]);

    expect(parsed.words).toEqual([{ text: " hello", start: 1, end: 1.2 }]);
    expect(parsed.skippedZeroDurationWords).toBe(1);
  });

  it("snaps a requested start or end to the nearest corresponding word boundary", () => {
    expect(snapToWordBoundary(1.7, words, "start")).toBe(1.5);
    expect(snapToWordBoundary(2.5, words, "end")).toBe(2.4);
  });

  it("nudges the selected edge by half a second and leaves the other edge unchanged", () => {
    expect(nudgeClipEdge(1, 3, "start", 1, 10, words)).toEqual({ start: 1.5, end: 3 });
    expect(nudgeClipEdge(1, 3, "end", -1, 10, words)).toEqual({ start: 1, end: 2.4 });
  });

  it("rejects a snapped trim that crosses the opposite edge", () => {
    expect(() => nudgeClipEdge(1, 1.3, "start", 1, 10, words)).toThrow(/positive duration/);
  });

  it("keeps a directional nudge moving in the requested direction", () => {
    expect(nudgeClipEdge(1, 3, "start", 1, 10, [
      { start: 1, end: 1.1 },
      { start: 2, end: 2.2 },
      { start: 2.5, end: 2.7 }
    ])).toEqual({ start: 2, end: 3 });
    expect(() => nudgeClipEdge(1, 3, "start", -1, 10, words)).toThrow(/move the start earlier/);
  });

  it("requires word boundaries and finite trim times", () => {
    expect(() => snapToWordBoundary(1, [], "start")).toThrow(/timestamps/);
    expect(() => snapToWordBoundary(Number.NaN, words, "end")).toThrow(/finite number/);
  });
});
