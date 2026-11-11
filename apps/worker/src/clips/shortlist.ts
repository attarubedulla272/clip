import type { TranscriptWord } from "../transcription/chunks.js";
import type { ClipTopicSegment } from "@clipforge/shared/clip-topics";
import { boundaryQualityScore, resolveSentenceBoundary } from "./boundaries.js";
import { CLIP_DETECTION_CONFIG } from "./ranking-config.js";
import { cosineSimilarity, type TopicSegmentation } from "./topics.js";
import type { ClipFunnelRemoval } from "@clipforge/shared/clip-funnel";

export interface ClipCandidate {
  start: number;
  end: number;
  transcriptText: string;
  signalsFound: string[];
  reason: string;
  topicId?: string;
  topicLabel?: string;
  heuristicSignalScore?: number;
  topicCoherenceScore?: number;
  boundaryQualityScore?: number;
  boundaryQualityReason?: string;
  ruleStandalone?: boolean;
  embedding?: number[];
  topicBoundaryCrossings?: number;
  speechPaceScore?: number;
  audioEnergyScore?: number;
  questionsPausesScore?: number;
  hookStrengthScore?: number;
  boundaryChanges?: string[];
  standaloneCheck?: import("@clipforge/shared/clip-standalone").ClipStandaloneCheck;
}

export interface SentenceRange {
  firstWord: number;
  lastWord: number;
  start: number;
  end: number;
  text: string;
}

export interface CandidateGenerationResult {
  candidates: ClipCandidate[];
  attemptedCount: number;
  generatedCount: number;
  removals: ClipFunnelRemoval[];
}

const stopWords = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "because",
  "been", "before", "being", "but", "by", "can", "could", "did", "do", "does", "for", "from", "had", "has",
  "have", "he", "her", "here", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "like",
  "me", "more", "most", "my", "no", "not", "of", "on", "one", "or", "our", "out", "she", "so", "some", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "too", "up", "us",
  "very", "was", "we", "were", "what", "when", "where", "which", "who", "will", "with", "would", "you", "your",
  "going", "know", "want", "like", "right", "yeah", "really", "just", "think", "thing"
]);

export function isSentenceEnd(word: TranscriptWord, nextWord: TranscriptWord | undefined) {
  return /[.!?।]["'”’)\]]*$/.test(word.text.trim()) ||
    (nextWord !== undefined && nextWord.start - word.end >= 0.9);
}

export function wordsToText(words: TranscriptWord[]) {
  return words.map((word) => word.text).join("").replace(/\s+/g, " ").trim();
}

function contentWords(text: string) {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]{3,}/gu) ?? [])
    .filter((word) => !stopWords.has(word));
}

export function buildTranscriptSentences(words: TranscriptWord[]): SentenceRange[] {
  const sentences: SentenceRange[] = [];
  let firstWord = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (!isSentenceEnd(word, words[index + 1])) continue;
    const sentenceWords = words.slice(firstWord, index + 1);
    if (sentenceWords.length > 0) {
      sentences.push({
        firstWord,
        lastWord: index,
        start: sentenceWords[0]!.start,
        end: word.end,
        text: wordsToText(sentenceWords)
      });
    }
    firstWord = index + 1;
  }
  if (firstWord < words.length) {
    const remainder = words.slice(firstWord);
    sentences.push({
      firstWord,
      lastWord: words.length - 1,
      start: remainder[0]!.start,
      end: remainder.at(-1)!.end,
      text: wordsToText(remainder)
    });
  }
  return sentences;
}

function keywordCounts(text: string) {
  const counts = new Map<string, number>();
  for (const word of contentWords(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

export function findCandidateSignals(
  words: TranscriptWord[],
  startWord: number,
  endWord: number,
  audioEnergyBySecond: number[]
) {
  const selection = words.slice(startWord, endWord + 1);
  if (selection.length === 0) return [];
  const start = selection[0]!.start;
  const end = selection.at(-1)!.end;
  const duration = end - start;
  if (duration <= 0) return [];
  const text = wordsToText(selection);
  const signals: string[] = [];
  const speechRate = selection.length * 60 / duration;

  if (speechRate >= 120) signals.push("Lively speech pace");
  const energyStart = Math.max(0, Math.floor(start));
  const energyEnd = Math.min(audioEnergyBySecond.length, Math.ceil(end));
  const energies = audioEnergyBySecond.slice(energyStart, energyEnd).filter(Number.isFinite);
  if (energies.length > 0) {
    const average = energies.reduce((sum, value) => sum + value, 0) / energies.length;
    const peak = Math.max(...energies);
    if (peak >= 0.06 && peak >= average * 1.6) signals.push("Audio energy peak");
  }
  const before = words[startWord - 1];
  const after = words[endWord + 1];
  const internalPause = selection.some((word, index) =>
    index > 0 && word.start - selection[index - 1]!.end >= 0.35
  );
  if (internalPause || (before && start - before.end >= 0.35) || (after && after.start - end >= 0.35)) {
    signals.push("Natural pause at a clip boundary");
  }
  if (/[?？]/u.test(text)) signals.push("Question");
  if (/[!！]/u.test(text)) signals.push("Exclamation");

  const counts = keywordCounts(text);
  const repeated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([word]) => word);
  const repeatedOccurrences = [...counts.values()].reduce((total, count) => total + (count > 1 ? count : 0), 0);
  if (repeated.length > 0 && repeatedOccurrences / Math.max(1, contentWords(text).length) >= 0.15) {
    signals.push(`Repeated keywords: ${repeated.join(", ")}`);
  }

  for (let index = 1; index < selection.length; index += 1) {
    const pause = selection[index]!.start - selection[index - 1]!.end;
    if (pause > 0.6) {
      signals.push("Topic shift");
      break;
    }
  }

  return signals;
}

export function scoreHeuristicSignals(
  words: TranscriptWord[],
  startWord: number,
  endWord: number,
  audioEnergyBySecond: number[],
  signals: string[]
) {
  const selected = words.slice(startWord, endWord + 1);
  const duration = selected.at(-1)!.end - selected[0]!.start;
  const speechRate = selected.length * 60 / Math.max(0.1, duration);
  const hasEnergy = signals.includes("Audio energy peak");
  const hasQuestion = signals.includes("Question");
  const hasPause = signals.includes("Natural pause at a clip boundary");
  const hasRepeatedKeyword = signals.some((signal) => signal.startsWith("Repeated keywords:"));
  const paceScore = speechRate < 70 ? 42 : speechRate < 100 ? 64 : speechRate <= 210 ? 92 : speechRate <= 260 ? 72 : 48;
  const energyScore = hasEnergy ? 100 : audioEnergyBySecond.length > 0 ? 48 : 40;
  const questionScore = hasQuestion ? 100 : 55;
  const pauseScore = hasPause ? 90 : 52;
  const keywordScore = hasRepeatedKeyword ? 85 : 55;
  const score = Math.round((paceScore + energyScore + questionScore + pauseScore + keywordScore) / 5);
  const details = [
    `${Math.round(speechRate)} words/min`,
    hasEnergy ? "audio peak detected" : "no strong audio peak",
    hasQuestion ? "question present" : "no question",
    hasPause ? "natural pause present" : "no clear pause",
    hasRepeatedKeyword ? "repeated keywords present" : "no repeated keywords"
  ];
  return { score, reason: details.join("; ").slice(0, 200) };
}

function explainCandidate(signals: string[], topicLabel: string, boundaryReason: string) {
  const evidence = signals.length > 0
    ? signals.map((signal) => signal.toLocaleLowerCase()).join(", ")
    : "a complete sentence-bounded thought";
  return `Topic: ${topicLabel}. Signals: ${evidence}. Boundaries: ${boundaryReason}.`;
}

function meanEmbedding(embeddings: number[][], start: number, end: number) {
  const dimensions = embeddings[0]?.length ?? 0;
  const mean = Array.from({ length: dimensions }, () => 0);
  for (let index = start; index < end; index += 1) {
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      mean[dimension]! += embeddings[index]![dimension]!;
    }
  }
  const count = Math.max(1, end - start);
  return mean.map((value) => value / count);
}

function getTopicDetails(
  firstSentence: number,
  lastSentence: number,
  startTime: number,
  endTime: number,
  topicSegmentation?: TopicSegmentation,
  storedTopics?: ClipTopicSegment[]
) {
  if (storedTopics?.length) {
    const overlaps = storedTopics.map((topic) => ({
      topic,
      seconds: Math.max(0, Math.min(endTime, topic.end) - Math.max(startTime, topic.start))
    })).filter(({ seconds }) => seconds > 0).sort((left, right) => right.seconds - left.seconds);
    const dominant = overlaps[0];
    if (dominant) {
      return {
        topicId: dominant.topic.id,
        topicLabel: dominant.topic.label,
        coherenceScore: Math.round(dominant.seconds / Math.max(1, endTime - startTime) * 100),
        topicBoundaryCrossings: Math.max(0, overlaps.length - 1)
      };
    }
  }
  if (!topicSegmentation) {
    return {
      topicId: `topic-${firstSentence + 1}`,
      topicLabel: `Topic ${firstSentence + 1}`,
      coherenceScore: 80,
      topicBoundaryCrossings: 0
    };
  }

  const counts = new Map<number, number>();
  const coherenceValues: number[] = [];
  for (let index = firstSentence; index <= lastSentence; index += 1) {
    const topicIndex = topicSegmentation.sentenceTopicIndices[index]!;
    counts.set(topicIndex, (counts.get(topicIndex) ?? 0) + 1);
    coherenceValues.push(topicSegmentation.sentenceCoherenceScores[index]!);
  }
  const dominant = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0];
  if (!dominant) throw new Error("Candidate does not contain a semantic topic");
  const topic = topicSegmentation.topics[dominant[0]]!;
  const purity = dominant[1] / (lastSentence - firstSentence + 1);
  const coherence = coherenceValues.reduce((sum, value) => sum + value, 0) / coherenceValues.length;
  return {
    topicId: topic.id,
    topicLabel: topic.label,
    coherenceScore: Math.round(coherence * 0.7 + purity * 100 * 0.3),
    topicBoundaryCrossings: Math.max(0, counts.size - 1)
  };
}

function scoreSpeechPace(words: TranscriptWord[], start: number, end: number) {
  const duration = Math.max(0.1, words[end]!.end - words[start]!.start);
  const wordsPerMinute = ((end - start + 1) * 60) / duration;
  return wordsPerMinute < 65 ? 38
    : wordsPerMinute < 90 ? 60
      : wordsPerMinute <= 190 ? 92
        : wordsPerMinute <= 240 ? 70
          : 45;
}

function scoreAudioEnergy(start: number, end: number, energies: number[]) {
  const selected = energies.slice(Math.max(0, Math.floor(start)), Math.min(energies.length, Math.ceil(end))).filter(Number.isFinite);
  if (selected.length === 0) return 45;
  const average = selected.reduce((sum, value) => sum + value, 0) / selected.length;
  const peak = Math.max(...selected);
  const peakLift = peak / Math.max(0.005, average);
  return Math.max(0, Math.min(100, Math.round(35 + Math.max(0, peakLift - 1) * 20 + peak * 80)));
}

function scoreQuestionsAndPauses(signals: string[]) {
  let score = 45;
  if (signals.includes("Question")) score += 25;
  if (signals.includes("Exclamation")) score += 12;
  if (signals.includes("Natural pause at a clip boundary")) score += 18;
  return Math.min(100, score);
}

function scoreHook(words: TranscriptWord[], startWord: number, endWord: number, energies: number[]) {
  const hookWords = words.slice(startWord, endWord + 1).filter((word) => word.start < words[startWord]!.start + 5);
  const hookText = wordsToText(hookWords);
  let score = 42;
  if (/[?？]/u.test(hookText)) score += 28;
  if (/[!！]/u.test(hookText)) score += 16;
  if (hookWords.length > 0 && scoreAudioEnergy(hookWords[0]!.start, hookWords.at(-1)!.end, energies) >= 70) score += 14;
  return Math.min(100, score);
}

export function removeOverlappingCandidates(candidates: ClipCandidate[]) {
  const ordered = [...candidates].sort((left, right) =>
    (right.signalsFound.length ?? 0) - (left.signalsFound.length ?? 0) ||
    (right.heuristicSignalScore ?? 0) - (left.heuristicSignalScore ?? 0) ||
    left.start - right.start
  );
  const selected: ClipCandidate[] = [];
  for (const candidate of ordered) {
    if (selected.some((existing) => candidate.start < existing.end && candidate.end > existing.start)) continue;
    selected.push(candidate);
  }
  return selected.sort((left, right) => left.start - right.start);
}

export function findClipCandidatesWithDiagnostics(
  words: TranscriptWord[],
  durationSeconds: number,
  audioEnergyBySecond: number[],
  maximumCandidatesOrEmbeddings?: number | number[][],
  topicSegmentation?: TopicSegmentation,
  maximumCandidatesOverride = CLIP_DETECTION_CONFIG.maximumCandidatesBeforeSelection,
  storedTopics?: ClipTopicSegment[]
): CandidateGenerationResult {
  const removals: ClipFunnelRemoval[] = [];
  const validWords = words.filter((word) =>
    Number.isFinite(word.start) && Number.isFinite(word.end) &&
    word.start >= 0 && word.end > word.start && word.end <= durationSeconds
  );
  const sentences = buildTranscriptSentences(validWords);
  if (sentences.length === 0) return { candidates: [], attemptedCount: 0, generatedCount: 0, removals };

  const embeddings = Array.isArray(maximumCandidatesOrEmbeddings)
    ? maximumCandidatesOrEmbeddings
    : [];
  const maximumCandidates = typeof maximumCandidatesOrEmbeddings === "number"
    ? maximumCandidatesOrEmbeddings
    : maximumCandidatesOverride;

  const candidates: ClipCandidate[] = [];
  const starts: number[] = [];
  let nextStartTime = sentences[0]!.start;
  for (let index = 0; index < sentences.length; index += 1) {
    if (sentences[index]!.start >= nextStartTime) {
      starts.push(index);
      nextStartTime = sentences[index]!.start + CLIP_DETECTION_CONFIG.candidateStartStepSeconds;
    }
  }
  const generated = new Map<string, ClipCandidate>();
  let attemptedCount = 0;
  for (const startSentence of starts) {
    const first = sentences[startSentence]!;
    for (const targetDuration of CLIP_DETECTION_CONFIG.candidateTargetDurationsSeconds) {
      attemptedCount += 1;
      const desiredEnd = first.start + targetDuration;
      let endSentence = startSentence;
      while (endSentence + 1 < sentences.length && sentences[endSentence]!.end < desiredEnd) endSentence += 1;
      let boundary = resolveSentenceBoundary(sentences, startSentence, endSentence);
      if (!boundary?.ruleStandalone) {
        removals.push({
          start: first.start,
          end: Math.max(first.end, sentences[endSentence]!.end),
          reason: "boundary-rule",
          detail: "Opening remained an unresolved reference after rule-based context resolution."
        });
        continue;
      }
      let resolvedStart = boundary.startSentence;
      let resolvedEnd = boundary.endSentence;
      if (resolvedEnd === sentences.length - 1 &&
        !/[.!?।]["'”’)\]]*$/.test(sentences[resolvedEnd]!.text.trim())) {
        removals.push({
          start: sentences[resolvedStart]!.start,
          end: sentences[resolvedEnd]!.end,
          reason: "boundary-rule",
          detail: "The final transcript fragment has no complete sentence ending."
        });
        continue;
      }
      let start = sentences[resolvedStart]!.start;
      let end = sentences[resolvedEnd]!.end;
      if (end - start < CLIP_DETECTION_CONFIG.minimumDurationSeconds && resolvedEnd + 1 < sentences.length) {
        resolvedEnd += 1;
        end = sentences[resolvedEnd]!.end;
      }
      if (end - start < CLIP_DETECTION_CONFIG.minimumDurationSeconds ||
        end - start > CLIP_DETECTION_CONFIG.maximumDurationSeconds) {
        removals.push({
          start,
          end: Math.max(start + 0.1, end),
          reason: "duration-limit",
          detail: `Candidate duration must be ${CLIP_DETECTION_CONFIG.minimumDurationSeconds}-${CLIP_DETECTION_CONFIG.maximumDurationSeconds} seconds.`
        });
        continue;
      }
      const phrase = validWords.slice(sentences[resolvedStart]!.firstWord, sentences[resolvedEnd]!.lastWord + 1);
      const transcriptText = wordsToText(phrase);
      const firstWord = sentences[resolvedStart]!.firstWord;
      const lastWord = sentences[resolvedEnd]!.lastWord;
      const signalsFound = findCandidateSignals(validWords, firstWord, lastWord, audioEnergyBySecond);
      const heuristic = scoreHeuristicSignals(validWords, firstWord, lastWord, audioEnergyBySecond, signalsFound);
      const topic = getTopicDetails(resolvedStart, resolvedEnd, start, end, topicSegmentation, storedTopics);
      const boundaryScore = boundaryQualityScore({
        firstSentence: sentences[resolvedStart]!,
        lastSentence: sentences[resolvedEnd]!,
        extendedBackward: boundary.extendedBackward,
        removedFillerSentences: boundary.removedFillerSentences,
        ruleStandalone: boundary.ruleStandalone,
        durationSeconds: end - start
      });
      const embedded = embeddings.length > 0 ? meanEmbedding(embeddings, resolvedStart, resolvedEnd + 1) : new Array(embeddingSize()).fill(0);
      const candidate: ClipCandidate = {
        start,
        end,
        transcriptText,
        signalsFound,
        reason: explainCandidate(signalsFound, topic.topicLabel, boundaryScore.reason),
        topicId: topic.topicId,
        topicLabel: topic.topicLabel,
        heuristicSignalScore: heuristic.score,
        topicCoherenceScore: topic.coherenceScore,
        boundaryQualityScore: boundaryScore.score,
        boundaryQualityReason: boundaryScore.reason,
        ruleStandalone: boundary.ruleStandalone,
        embedding: embedded,
        topicBoundaryCrossings: topic.topicBoundaryCrossings,
        speechPaceScore: scoreSpeechPace(validWords, firstWord, lastWord),
        audioEnergyScore: scoreAudioEnergy(start, end, audioEnergyBySecond),
        questionsPausesScore: scoreQuestionsAndPauses(signalsFound),
        hookStrengthScore: scoreHook(validWords, firstWord, lastWord, audioEnergyBySecond)
      };
      const key = `${start.toFixed(2)}:${end.toFixed(2)}`;
      if (generated.has(key)) {
        removals.push({
          start,
          end,
          reason: "duplicate-window",
          detail: "This exact sentence-bounded window was generated more than once."
        });
      } else {
        generated.set(key, candidate);
      }
    }
  }

  candidates.push(...generated.values());
  const generatedCount = candidates.length;
  if (candidates.length <= Math.max(0, maximumCandidates)) {
    return { candidates, attemptedCount, generatedCount, removals };
  }
  const byTime = [...candidates].sort((left, right) => left.start - right.start || (left.end - left.start) - (right.end - right.start));
  const sampled: ClipCandidate[] = [];
  const stride = byTime.length / Math.max(1, maximumCandidates);
  for (let index = 0; index < maximumCandidates; index += 1) {
    const candidate = byTime[Math.floor(index * stride)];
    if (candidate) sampled.push(candidate);
  }
  const sampledKeys = new Set(sampled.map((candidate) => `${candidate.start.toFixed(2)}:${candidate.end.toFixed(2)}`));
  for (const candidate of candidates) {
    if (sampledKeys.has(`${candidate.start.toFixed(2)}:${candidate.end.toFixed(2)}`)) continue;
    removals.push({
      start: candidate.start,
      end: candidate.end,
      reason: "candidate-limit",
      detail: `Candidate window limit (${maximumCandidates}) kept a time-distributed subset.`
    });
  }
  return { candidates: sampled, attemptedCount, generatedCount, removals };
}

export function findClipCandidates(
  words: TranscriptWord[],
  durationSeconds: number,
  audioEnergyBySecond: number[],
  maximumCandidatesOrEmbeddings?: number | number[][],
  topicSegmentation?: TopicSegmentation,
  maximumCandidatesOverride = CLIP_DETECTION_CONFIG.maximumCandidatesBeforeSelection,
  storedTopics?: ClipTopicSegment[]
) {
  return findClipCandidatesWithDiagnostics(
    words,
    durationSeconds,
    audioEnergyBySecond,
    maximumCandidatesOrEmbeddings,
    topicSegmentation,
    maximumCandidatesOverride,
    storedTopics
  ).candidates;
}

function embeddingSize() {
  return 384;
}

export function candidateSimilarity(left: ClipCandidate, right: ClipCandidate) {
  const leftEmbedding = left.embedding ?? Array.from({ length: embeddingSize() }, () => 0);
  const rightEmbedding = right.embedding ?? Array.from({ length: embeddingSize() }, () => 0);
  return cosineSimilarity(leftEmbedding, rightEmbedding);
}
