import { describe, expect, it } from "vitest";
import {
  findCandidateSignals,
  findClipCandidates,
  findClipCandidatesWithDiagnostics,
  buildTranscriptSentences,
  removeOverlappingCandidates,
  type ClipCandidate
} from "./shortlist.js";
import type { TranscriptWord } from "../transcription/chunks.js";
import type { ClipTopicSegment } from "@clipforge/shared/clip-topics";

function wordsFromSentences(sentences: string[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let time = 0;
  for (const sentence of sentences) {
    for (const token of sentence.split(/\s+/)) {
      words.push({ text: `${token} `, start: time, end: time + 0.3 });
      time += 0.8;
    }
    words[words.length - 1]!.text = words.at(-1)!.text.trimEnd();
    time += 0.8;
  }
  return words;
}

describe("findClipCandidates", () => {
  it("snaps both boundaries to complete sentence ends and never splits a word", () => {
    const words = wordsFromSentences([
      "A clear opening explains the important idea in a simple way.",
      "The next sentence adds a useful example for people to remember.",
      "Finally we explain why this small change matters to everyone."
    ]);
    const candidates = findClipCandidates(words, 30, Array(30).fill(0));

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(words.some((word) => word.start === candidate.start)).toBe(true);
      expect(words.some((word) => word.end === candidate.end && /[.!?]$/.test(word.text.trim()))).toBe(true);
      expect(candidate.end - candidate.start).toBeGreaterThanOrEqual(15);
      expect(candidate.end - candidate.start).toBeLessThanOrEqual(60);
    }
  });

  it("returns at most ten candidates", () => {
    const words = wordsFromSentences(Array.from({ length: 60 }, (_, index) =>
      `Sentence ${index} explains a useful idea with an example and a clear point.`
    ));
    expect(findClipCandidates(words, 360, Array(360).fill(0), 3)).toHaveLength(3);
  });

  it("reports distinct duplicate windows and only counts cap-discarded candidates as candidate-limit", () => {
    const words = wordsFromSentences(Array.from({ length: 60 }, (_, index) =>
      `${index % 2 === 0 ? "And" : "This"} sentence ${index} explains a useful idea with an example and a clear point.`
    ));
    const result = findClipCandidatesWithDiagnostics(words, 400, Array(400).fill(0), 20);
    const capRemovals = result.removals.filter(({ reason }) => reason === "candidate-limit");
    const duplicateWindows = result.removals.filter(({ reason }) => reason === "duplicate-window");

    expect(result.generatedCount).toBeGreaterThanOrEqual(result.candidates.length);
    expect(capRemovals.length).toBe(result.generatedCount - result.candidates.length);
    expect(duplicateWindows.every(({ detail }) => detail.includes("generated more than once"))).toBe(true);
  });

  it("generates varied 20-60 second windows on sentence boundaries", () => {
    const words = wordsFromSentences(Array.from({ length: 60 }, (_, index) =>
      `Sentence ${index} explains a useful idea with an example and a clear point.`
    ));
    const candidates = findClipCandidates(words, 400, Array(400).fill(0), 60);
    const durations = new Set(candidates.map((entry) => Math.round(entry.end - entry.start)));
    const sentenceBoundaries = buildTranscriptSentences(words).map((sentence) => sentence.end);

    expect(candidates.length).toBeGreaterThan(30);
    expect(candidates.length).toBeLessThanOrEqual(60);
    expect(durations.size).toBeGreaterThan(1);
    for (const entry of candidates) {
      expect(entry.end - entry.start).toBeGreaterThanOrEqual(20);
      expect(entry.end - entry.start).toBeLessThanOrEqual(60);
      expect(words.some((word) => word.start === entry.start)).toBe(true);
      expect(sentenceBoundaries).toContain(entry.end);
    }
  });

  it("maps stored topic segments using candidate timestamps, not sentence indexes", () => {
    const words = wordsFromSentences(Array.from({ length: 60 }, (_, index) =>
      `Sentence ${index} explains a useful idea with an example and a clear point.`
    ));
    const topics: ClipTopicSegment[] = [
      { id: "topic-a", index: 0, start: 0, end: 100, label: "first subject", text: "First subject details.", contextBefore: [], contextAfter: [] },
      { id: "topic-b", index: 1, start: 100, end: 200, label: "second subject", text: "Second subject details.", contextBefore: [], contextAfter: [] },
      { id: "topic-c", index: 2, start: 200, end: 400, label: "third subject", text: "Third subject details.", contextBefore: [], contextAfter: [] }
    ];

    const candidates = findClipCandidates(words, 400, Array(400).fill(0), 60, undefined, 60, topics);
    const laterCandidate = candidates.find((candidate) => candidate.start >= 210 && candidate.end <= 390);

    expect(laterCandidate).toBeDefined();
    expect(laterCandidate?.topicId).toBe("topic-c");
    expect(laterCandidate?.topicLabel).toBe("third subject");
  });
});

describe("removeOverlappingCandidates", () => {
  it("keeps the stronger non-overlapping candidate and removes overlaps", () => {
    const candidates: ClipCandidate[] = [
      { start: 0, end: 20, transcriptText: "first", signalsFound: ["question"], reason: "first" },
      { start: 10, end: 30, transcriptText: "overlap", signalsFound: ["pace", "energy"], reason: "overlap" },
      { start: 30, end: 50, transcriptText: "touching", signalsFound: [], reason: "touching" }
    ];

    expect(removeOverlappingCandidates(candidates).map(({ transcriptText }) => transcriptText))
      .toEqual(["overlap", "touching"]);
  });
});

describe("findCandidateSignals", () => {
  it("detects speech pace, audio energy, pauses, questions, exclamations, keywords, and topic shifts", () => {
    const words: TranscriptWord[] = [];
    for (let index = 0; index < 36; index += 1) {
      const text = index === 11 ? "why? " : index === 23 ? "now! " : index % 4 === 0 ? "camera " : `idea${index} `;
      words.push({
        text,
        start: index * 0.35 + (index > 12 ? 0.5 : 0),
        end: index * 0.35 + (index > 12 ? 0.5 : 0) + 0.25
      });
    }
    const signals = findCandidateSignals(words, 0, words.length - 1, [0.05, 0.05, 0.3, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]);

    expect(signals).toContain("Lively speech pace");
    expect(signals).toContain("Audio energy peak");
    expect(signals).toContain("Natural pause at a clip boundary");
    expect(signals).toContain("Question");
    expect(signals).toContain("Exclamation");
    expect(signals).toContain("Repeated keywords: camera");
    expect(signals).toContain("Topic shift");
  });
});
