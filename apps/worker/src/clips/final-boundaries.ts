import { clipStandaloneAssessmentSchema, type ClipStandaloneCheck } from "@clipforge/shared/clip-standalone";
import type { TranscriptWord } from "../transcription/chunks.js";
import type { LlmProvider } from "../llm/llm-provider.js";
import { buildTranscriptSentences, wordsToText, type ClipCandidate, type SentenceRange } from "./shortlist.js";
import { isFillerOnlySentence, startsWithUnresolvedReference } from "./boundaries.js";
import { CLIP_DETECTION_CONFIG } from "./ranking-config.js";

export interface FinalBoundaryResult {
  candidate: ClipCandidate;
  standaloneCheck: ClipStandaloneCheck;
  changes: string[];
}

function normalizedWord(text: string) {
  return text.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function sentenceIndexAtStart(sentences: SentenceRange[], start: number) {
  return sentences.findIndex((sentence) => Math.abs(sentence.start - start) < 0.02);
}

function sentenceIndexAtEnd(sentences: SentenceRange[], end: number) {
  return sentences.findIndex((sentence) => Math.abs(sentence.end - end) < 0.02);
}

function startsForCandidate(candidate: ClipCandidate) {
  return candidate.transcriptText.trim().match(/^[\p{L}\p{M}]+/u)?.[0] ?? "";
}

function hasTerminalPunctuation(sentence: SentenceRange) {
  return /[.!?।]["'”’)\]]*$/.test(sentence.text.trim());
}

function sentenceEndsWeakly(sentence: SentenceRange) {
  if (!hasTerminalPunctuation(sentence)) return true;
  const last = sentence.text.trim().match(/[\p{L}\p{M}]+[.!?।,;:]?$/u)?.[0] ?? "";
  const token = normalizedWord(last);
  return (CLIP_DETECTION_CONFIG.trailingWeakEndingWords as readonly string[]).includes(token);
}

function snapStartToWord(words: TranscriptWord[], requested: number, lowerBound: number) {
  return words.find((word) => word.start >= lowerBound && Math.abs(word.start - requested) < 0.02)?.start;
}

function snapEndToWord(words: TranscriptWord[], requested: number, upperBound: number) {
  return words.find((word) => word.end >= requested - 0.001 && word.end <= upperBound + 0.001)?.end;
}

function finalRulesPass(candidate: ClipCandidate) {
  const opening = startsForCandidate(candidate);
  const ends = /[.!?।]["'”’)\]]*$/.test(candidate.transcriptText.trim());
  const last = candidate.transcriptText.trim().match(/[\p{L}\p{M}]+[.!?।,;:]?$/u)?.[0] ?? "";
  return !startsWithUnresolvedReference(candidate.transcriptText) &&
    !(CLIP_DETECTION_CONFIG.leadingFillerWords as readonly string[]).includes(normalizedWord(opening)) &&
    ends && !(CLIP_DETECTION_CONFIG.trailingWeakEndingWords as readonly string[]).includes(normalizedWord(last));
}

function maintainDuration(
  words: TranscriptWord[],
  sentences: SentenceRange[],
  start: number,
  end: number,
  changes: string[]
) {
  const minimum = CLIP_DETECTION_CONFIG.minimumFinalClipSeconds;
  const maximum = CLIP_DETECTION_CONFIG.maximumFinalClipSeconds;
  let firstIndex = sentences.findIndex((sentence) => start >= sentence.start && start < sentence.end);
  let lastIndex = sentences.findIndex((sentence) => end > sentence.start && end <= sentence.end + 0.02);
  if (firstIndex < 0) firstIndex = sentences.findIndex((sentence) => sentence.start >= start);
  if (lastIndex < 0) lastIndex = sentences.findIndex((sentence) => sentence.end >= end);
  if (firstIndex < 0 || lastIndex < firstIndex) return undefined;

  let resolvedStart = start;
  while (sentences[lastIndex]!.end - resolvedStart > maximum && lastIndex > firstIndex) {
    lastIndex -= 1;
    changes.push("Trimmed to stay within the 60-second clip limit.");
  }
  while (sentences[lastIndex]!.end - resolvedStart < minimum && lastIndex + 1 < sentences.length &&
    sentences[lastIndex + 1]!.end - resolvedStart <= maximum) {
    lastIndex += 1;
    changes.push("Extended to include a complete sentence and meet the 15-second minimum.");
  }
  const snappedStart = snapStartToWord(words, resolvedStart, 0);
  const snappedEnd = snapEndToWord(words, sentences[lastIndex]!.end, words.at(-1)?.end ?? sentences[lastIndex]!.end);
  if (snappedStart === undefined || snappedEnd === undefined ||
    snappedEnd - snappedStart < minimum || snappedEnd - snappedStart > maximum) return undefined;
  return { start: snappedStart, end: snappedEnd, firstIndex, lastIndex };
}

function updateCandidate(
  candidate: ClipCandidate,
  words: TranscriptWord[],
  sentences: SentenceRange[],
  start: number,
  end: number,
  changes: string[]
) {
  const durationAdjusted = maintainDuration(words, sentences, start, end, changes);
  if (!durationAdjusted) throw new Error("Could not keep the final clip within the 15-60 second sentence-boundary limits.");
  const selectedWords = words.filter((word) =>
    word.start >= durationAdjusted.start && word.end <= durationAdjusted.end
  );
  if (selectedWords.length === 0) throw new Error("Final clip boundaries do not contain transcript words.");
  const transcriptText = wordsToText(selectedWords);
  const ruleStandalone = finalRulesPass({ ...candidate, transcriptText });
  const boundaryScore = Math.max(0, Math.min(100,
    70 + (ruleStandalone ? 20 : 0) - changes.length * 5
  ));
  const boundaryReason = [
    "sentence-aligned word boundaries",
    ruleStandalone ? "opening and payoff pass the rules-only standalone check" : "rules-only check still sees an unresolved opening or ending",
    ...changes
  ].join("; ").slice(0, 200);
  return {
    ...candidate,
    start: durationAdjusted.start,
    end: durationAdjusted.end,
    transcriptText,
    ruleStandalone,
    boundaryQualityScore: boundaryScore,
    boundaryQualityReason: boundaryReason,
    reason: `${candidate.reason} Final boundaries: ${boundaryReason}`.slice(0, 500)
  };
}

export function refineSelectedClipRules(
  words: TranscriptWord[],
  candidate: ClipCandidate
) {
  const sentences = buildTranscriptSentences(words);
  let startIndex = sentenceIndexAtStart(sentences, candidate.start);
  let endIndex = sentenceIndexAtEnd(sentences, candidate.end);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new Error("Selected clip boundaries do not align with the saved transcript sentences.");
  }
  const changes: string[] = [];
  let requestedStart: number | undefined;

  while (startIndex <= endIndex && isFillerOnlySentence(sentences[startIndex]!.text)) {
    const nextSentence = sentences[startIndex + 1];
    if (!nextSentence || sentences[endIndex]!.end - nextSentence.start < CLIP_DETECTION_CONFIG.minimumFinalClipSeconds) break;
    changes.push(`Trimmed leading filler sentence "${sentences[startIndex]!.text.trim()}".`);
    startIndex += 1;
  }

  const firstWord = words[sentences[startIndex]!.firstWord];
  const firstToken = firstWord?.text.trim() ?? "";
  const firstTokenNormalized = normalizedWord(firstToken);
  const nextWord = words[sentences[startIndex]!.firstWord + 1];
  const punctuationDelimitedFiller = /[,;:]$/u.test(firstToken) ||
    (CLIP_DETECTION_CONFIG.fillerWordsWithoutComma as readonly string[]).includes(firstTokenNormalized);
  if (firstWord && nextWord &&
    (CLIP_DETECTION_CONFIG.leadingFillerWords as readonly string[]).includes(firstTokenNormalized) &&
    punctuationDelimitedFiller &&
    sentences[endIndex]!.end - nextWord.start >= CLIP_DETECTION_CONFIG.minimumFinalClipSeconds) {
    requestedStart = nextWord.start;
    changes.push(`Trimmed leading filler "${firstToken}".`);
  }

  let firstText = sentences[startIndex]!.text;
  while (!requestedStart && startsWithUnresolvedReference(firstText) &&
    startIndex > 0 &&
    !isFillerOnlySentence(sentences[startIndex - 1]!.text) &&
    candidate.end - sentences[startIndex - 1]!.start <= CLIP_DETECTION_CONFIG.maximumFinalClipSeconds &&
    changes.filter((change) => change.startsWith("Started earlier")).length < CLIP_DETECTION_CONFIG.maximumStartExtensionSentences) {
    startIndex -= 1;
    changes.push(`Started ${(sentences[startIndex + 1]!.start - sentences[startIndex]!.start).toFixed(1)}s earlier to include the preceding context.`);
    firstText = sentences[startIndex]!.text;
  }

  if (sentenceEndsWeakly(sentences[endIndex]!) && endIndex > startIndex &&
    sentences[endIndex - 1]!.end - sentences[startIndex]!.start >= CLIP_DETECTION_CONFIG.minimumFinalClipSeconds) {
    changes.push("Trimmed the trailing weak fragment after the payoff sentence.");
    endIndex -= 1;
  }

  const refined = updateCandidate(
    candidate,
    words,
    sentences,
    requestedStart ?? sentences[startIndex]!.start,
    sentences[endIndex]!.end,
    changes
  );
  return { candidate: refined, changes, sentences };
}

function applySuggestedAdjustment(
  sentences: SentenceRange[],
  candidate: ClipCandidate,
  startAdjustmentSeconds: number,
  endAdjustmentSeconds: number,
  changes: string[]
) {
  const maxAdjustment = CLIP_DETECTION_CONFIG.maximumStandaloneAdjustmentSeconds;
  const startAdjustment = Math.max(-maxAdjustment, Math.min(maxAdjustment, startAdjustmentSeconds));
  const endAdjustment = Math.max(-maxAdjustment, Math.min(maxAdjustment, endAdjustmentSeconds));
  let start = candidate.start;
  let end = candidate.end;
  if (startAdjustment !== 0) {
    if (startAdjustment < 0) {
      const previous = [...sentences].reverse().find((sentence) =>
        sentence.start < start && start - sentence.start <= maxAdjustment
      );
      if (previous) {
        start = previous.start;
        changes.push(`Started ${(candidate.start - start).toFixed(1)}s earlier to include the suggested context.`);
      }
    } else {
      const next = sentences.find((sentence) =>
        sentence.start > start && sentence.start < end && sentence.start - start <= maxAdjustment
      );
      if (next && end - next.start >= CLIP_DETECTION_CONFIG.minimumFinalClipSeconds) {
        start = next.start;
        changes.push(`Trimmed ${ (start - candidate.start).toFixed(1)}s from the opening at a sentence boundary.`);
      }
    }
  }
  if (endAdjustment !== 0) {
    if (endAdjustment > 0) {
      const next = sentences.find((sentence) =>
        sentence.end > end && sentence.end - end <= maxAdjustment
      );
      if (next && next.end - start <= CLIP_DETECTION_CONFIG.maximumFinalClipSeconds) {
        end = next.end;
        changes.push(`Extended ${ (end - candidate.end).toFixed(1)}s through the suggested payoff sentence.`);
      }
    } else {
      const previous = [...sentences].reverse().find((sentence) =>
        sentence.end < end && end - sentence.end <= maxAdjustment
      );
      if (previous && previous.end - start >= CLIP_DETECTION_CONFIG.minimumFinalClipSeconds) {
        end = previous.end;
        changes.push(`Trimmed ${ (candidate.end - end).toFixed(1)}s after the suggested payoff sentence.`);
      }
    }
  }
  return { start, end };
}

async function requestAssessment(provider: LlmProvider, transcript: string) {
  if (!provider.generateStandaloneJson) throw new Error(`${provider.providerName ?? "LLM"} does not support standalone checks`);
  let latestError = "Standalone response was invalid";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await provider.generateStandaloneJson(transcript);
    try {
      const parsed = JSON.parse(raw) as unknown;
      const result = clipStandaloneAssessmentSchema.safeParse(parsed);
      if (result.success) return result.data;
      latestError = result.error.issues.map((issue) => issue.message).join(", ");
    } catch {
      latestError = "Provider returned invalid JSON";
    }
  }
  throw new Error(latestError);
}

export async function finalizeSelectedClip(
  words: TranscriptWord[],
  candidate: ClipCandidate,
  providers: LlmProvider[]
): Promise<FinalBoundaryResult> {
  const rulePass = refineSelectedClipRules(words, candidate);
  let current = rulePass.candidate;
  const changes = [...rulePass.changes];
  let adjustmentApplied = false;
  let assessment: ReturnType<typeof clipStandaloneAssessmentSchema.parse> | undefined;
  let provider: ClipStandaloneCheck["provider"] = "Rules";
  for (const candidateProvider of providers) {
    try {
      assessment = await requestAssessment(candidateProvider, current.transcriptText);
      provider = candidateProvider.providerName ?? "Ollama";
      break;
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        event: "clip.standalone.provider.failed",
        provider: candidateProvider.providerName ?? "Ollama",
        message: error instanceof Error ? error.message : "Unknown standalone assessment error"
      }));
    }
  }

  if (assessment && !assessment.standsAlone &&
    (assessment.suggestedStartAdjustmentSeconds !== 0 || assessment.suggestedEndAdjustmentSeconds !== 0)) {
    const adjustment = applySuggestedAdjustment(
      rulePass.sentences,
      current,
      assessment.suggestedStartAdjustmentSeconds,
      assessment.suggestedEndAdjustmentSeconds,
      changes
    );
    if (adjustment.start !== current.start || adjustment.end !== current.end) {
      current = updateCandidate(current, words, rulePass.sentences, adjustment.start, adjustment.end, changes);
      adjustmentApplied = true;
    }
  }

  const rulesPass = finalRulesPass(current);
  const standsAlone = assessment
    ? assessment.standsAlone ? rulesPass : adjustmentApplied && rulesPass
    : rulesPass;
  const reason = assessment
    ? `${assessment.reason}${adjustmentApplied && rulesPass
      ? " Suggested adjustment applied; final rules recheck passes."
      : rulesPass ? "" : " Rules still detect an unresolved opening or ending."}`.slice(0, 180)
    : rulesPass
      ? "Rules-only check: begins with a resolved thought and ends at a complete payoff sentence."
      : "Rules-only check: the opening or ending still depends on missing context.";

  return {
    candidate: current,
    changes,
    standaloneCheck: {
      standsAlone,
      reason,
      suggestedStartAdjustmentSeconds: assessment?.suggestedStartAdjustmentSeconds ?? 0,
      suggestedEndAdjustmentSeconds: assessment?.suggestedEndAdjustmentSeconds ?? 0,
      provider,
      rulesPass
    }
  };
}
