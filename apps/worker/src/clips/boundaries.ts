import { CLIP_DETECTION_CONFIG } from "./ranking-config.js";

export interface SentenceBoundary {
  start: number;
  end: number;
  text: string;
}

export interface ResolvedSentenceBoundary {
  startSentence: number;
  endSentence: number;
  extendedBackward: boolean;
  removedFillerSentences: number;
  ruleStandalone: boolean;
}

const unresolvedReferences = new Set<string>(CLIP_DETECTION_CONFIG.unresolvedOpeningWords);
const fillerOnlyWords = new Set<string>([
  ...CLIP_DETECTION_CONFIG.leadingFillerWords,
  ...CLIP_DETECTION_CONFIG.fillerWordsWithoutComma,
  "hmm",
  "you",
  "know",
  "i",
  "mean"
]);

export function startsWithUnresolvedReference(text: string) {
  const firstWord = text.trim().match(/^[\p{L}\p{M}]+/u)?.[0]?.toLocaleLowerCase();
  return firstWord ? unresolvedReferences.has(firstWord) : false;
}

export function isFillerOnlySentence(text: string) {
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
  return words.length > 0 && words.every((word) => fillerOnlyWords.has(word));
}

export function resolveSentenceBoundary(
  sentences: SentenceBoundary[],
  startSentence: number,
  endSentence: number
): ResolvedSentenceBoundary | undefined {
  let first = startSentence;
  let last = endSentence;
  let removedFillerSentences = 0;
  while (first <= last && isFillerOnlySentence(sentences[first]!.text)) {
    first += 1;
    removedFillerSentences += 1;
  }
  if (first > last) return undefined;

  let extendedBackward = false;
  let extensions = 0;
  while (startsWithUnresolvedReference(sentences[first]!.text) &&
    extensions < CLIP_DETECTION_CONFIG.maximumStartExtensionSentences &&
    first > 0) {
    const previous = first - 1;
    if (isFillerOnlySentence(sentences[previous]!.text)) break;
    if (sentences[last]!.end - sentences[previous]!.start > CLIP_DETECTION_CONFIG.maximumDurationSeconds) break;
    first = previous;
    extensions += 1;
    extendedBackward = true;
  }

  const startsResolved = !startsWithUnresolvedReference(sentences[first]!.text);
  const hasContent = /[\p{L}\p{N}]/u.test(sentences[first]!.text);
  const endIsSentenceBoundary = sentences[last]!.end > sentences[last]!.start;
  return {
    startSentence: first,
    endSentence: last,
    extendedBackward,
    removedFillerSentences,
    ruleStandalone: startsResolved && hasContent && endIsSentenceBoundary
  };
}

export function boundaryQualityScore(
  input: {
    firstSentence: SentenceBoundary;
    lastSentence: SentenceBoundary;
    extendedBackward: boolean;
    removedFillerSentences: number;
    ruleStandalone: boolean;
    durationSeconds: number;
  }
) {
  let score = 45;
  const reasons = ["starts and ends on complete sentence boundaries"];
  if (input.ruleStandalone) {
    score += 20;
    reasons.push("opening has no unresolved reference");
  } else {
    reasons.push("opening may need more context");
  }
  if (/[.!?।]["'”’)\]]*$/.test(input.lastSentence.text.trim())) {
    score += 15;
    reasons.push("ending sentence has terminal punctuation");
  } else {
    score += 8;
    reasons.push("ending uses a detected natural pause");
  }
  if (input.extendedBackward) {
    score += 8;
    reasons.push("opening was extended to include context");
  }
  if (input.removedFillerSentences > 0) {
    score += 6;
    reasons.push("leading filler was removed");
  }
  if (input.durationSeconds >= CLIP_DETECTION_CONFIG.minimumDurationSeconds &&
    input.durationSeconds <= CLIP_DETECTION_CONFIG.maximumDurationSeconds) {
    score += 6;
    reasons.push("duration stays within 15–60 seconds");
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reason: reasons.join("; ").slice(0, 200)
  };
}
