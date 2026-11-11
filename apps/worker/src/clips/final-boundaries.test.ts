import { describe, expect, it } from "vitest";
import type { LlmProvider } from "../llm/llm-provider.js";
import type { ClipCandidate } from "./shortlist.js";
import type { TranscriptWord } from "../transcription/chunks.js";
import { finalizeSelectedClip, refineSelectedClipRules } from "./final-boundaries.js";
import { isFillerOnlySentence } from "./boundaries.js";

function transcript(sentences: string[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let time = 0;
  for (const sentence of sentences) {
    const tokens = sentence.split(/\s+/);
    for (const [index, token] of tokens.entries()) {
      words.push({
        text: token + (index === tokens.length - 1 ? "" : " "),
        start: time,
        end: time + 0.25
      });
      time += 0.45;
    }
    time += 1.2;
  }
  return words;
}

function candidateFrom(words: TranscriptWord[], startIndex = 0, endIndex = words.length - 1): ClipCandidate {
  const selected = words.slice(startIndex, endIndex + 1);
  return {
    start: selected[0]!.start,
    end: selected.at(-1)!.end,
    transcriptText: selected.map((word) => word.text).join("").trim(),
    signalsFound: [],
    reason: "Scored candidate."
  };
}

function repeatedSentence(start: string, count = 42) {
  const words = [start, ...Array.from({ length: count - 2 }, (_, index) => `detail${index}`), "matters."];
  return words.join(" ");
}

describe("final selected clip boundaries", () => {
  it("trims leading filler sentences while preserving sentence boundaries", () => {
    const words = transcript(["Um.", repeatedSentence("This"), repeatedSentence("The")]);
    expect(isFillerOnlySentence("Um.")).toBe(true);
    const original = candidateFrom(words);
    const result = refineSelectedClipRules(words, original);

    expect(result.changes).toContain('Trimmed leading filler sentence "Um.".');
    expect(result.candidate.start).toBe(words[1]!.start);
    expect(result.candidate.transcriptText.startsWith("Um")).toBe(false);
    expect(result.changes.some((change) => change.includes("Trimmed leading filler"))).toBe(true);
  });

  it("trims a comma-delimited spoken filler word before the clip's first complete sentence", () => {
    const words = transcript([`Yeah, ${repeatedSentence("I")}`, repeatedSentence("The")]);
    const original = candidateFrom(words);
    const result = refineSelectedClipRules(words, original);

    expect(result.candidate.transcriptText.startsWith("I detail0")).toBe(true);
    expect(result.candidate.start).toBe(words[1]!.start);
    expect(result.changes).toContain('Trimmed leading filler "Yeah,".');
  });

  it("extends an unresolved opening to the previous sentence within the 60-second cap", () => {
    const words = transcript([repeatedSentence("The", 20), repeatedSentence("This", 30), repeatedSentence("Another", 20)]);
    const secondSentenceStart = words.findIndex((word) => word.text.startsWith("This"));
    const lastSentenceEnd = words.length - 1;
    const original = candidateFrom(words, secondSentenceStart, lastSentenceEnd);
    const result = refineSelectedClipRules(words, original);

    expect(result.candidate.start).toBe(words[0]!.start);
    expect(result.candidate.end - result.candidate.start).toBeLessThanOrEqual(60);
    expect(result.candidate.transcriptText.startsWith("The")).toBe(true);
    expect(result.changes.some((change) => change.startsWith("Started "))).toBe(true);
  });

  it("ends at the completed payoff sentence instead of a trailing weak fragment", () => {
    const words = transcript([
      repeatedSentence("The"),
      "And this unfinished point continues with another thought and"
    ]);
    const original = candidateFrom(words);
    const result = refineSelectedClipRules(words, original);
    const payoffEnd = [...words].reverse().find((word) => word.text.endsWith("matters."))!.end;

    expect(result.candidate.end).toBe(payoffEnd);
    expect(result.candidate.transcriptText.endsWith("matters.")).toBe(true);
    expect(result.changes).toContain("Trimmed the trailing weak fragment after the payoff sentence.");
  });

  it("keeps every final clip between 15 and 60 seconds", () => {
    const words = transcript([repeatedSentence("A"), repeatedSentence("The"), repeatedSentence("Another")]);
    const result = refineSelectedClipRules(words, candidateFrom(words));

    expect(result.candidate.end - result.candidate.start).toBeGreaterThanOrEqual(15);
    expect(result.candidate.end - result.candidate.start).toBeLessThanOrEqual(60);
    expect(words.some((word) => word.start === result.candidate.start)).toBe(true);
    expect(words.some((word) => word.end === result.candidate.end)).toBe(true);
  });

  it("uses rules-only standalone checks when no local or opted-in provider is available", async () => {
    const words = transcript([repeatedSentence("A"), repeatedSentence("The")]);
    const result = await finalizeSelectedClip(words, candidateFrom(words), []);

    expect(result.standaloneCheck.provider).toBe("Rules");
    expect(result.standaloneCheck.rulesPass).toBe(true);
    expect(result.standaloneCheck.standsAlone).toBe(true);
  });

  it("rules veto an LLM yes when the clip opens with an unresolved mid-thought reference", async () => {
    const words = transcript([
      "And that is why it failed.",
      repeatedSentence("The"),
      repeatedSentence("Another")
    ]);
    const provider: LlmProvider = {
      providerName: "Ollama",
      modelName: "test",
      async generateScoreJson() { return "{}"; },
      async generateStandaloneJson() {
        return JSON.stringify({
          standsAlone: true,
          reason: "The idea seems clear.",
          suggestedStartAdjustmentSeconds: 0,
          suggestedEndAdjustmentSeconds: 0
        });
      }
    };

    const result = await finalizeSelectedClip(words, candidateFrom(words), [provider]);

    expect(result.standaloneCheck.provider).toBe("Ollama");
    expect(result.standaloneCheck.rulesPass).toBe(false);
    expect(result.standaloneCheck.standsAlone).toBe(false);
  });

  it("applies a validated suggested adjustment once, then checks the adjusted clip with rules", async () => {
    const words = transcript(["A brief prior context sentence.", repeatedSentence("A"), repeatedSentence("Another")]);
    const secondSentenceStart = 5;
    const lastSentenceEnd = words.length - 1;
    const provider: LlmProvider = {
      providerName: "Ollama",
      modelName: "test",
      async generateScoreJson() { return "{}"; },
      async generateStandaloneJson() {
        return JSON.stringify({
          standsAlone: false,
          reason: "The opening would benefit from one sentence of context.",
          suggestedStartAdjustmentSeconds: -5,
          suggestedEndAdjustmentSeconds: 0
        });
      }
    };

    const result = await finalizeSelectedClip(
      words,
      candidateFrom(words, secondSentenceStart, lastSentenceEnd),
      [provider]
    );

    expect(result.candidate.start).toBe(words[0]!.start);
    expect(result.standaloneCheck.provider).toBe("Ollama");
    expect(result.standaloneCheck.standsAlone).toBe(true);
    expect(result.standaloneCheck.rulesPass).toBe(true);
  });
});
