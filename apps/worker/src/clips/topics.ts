import type { ClipTopicSegment } from "@clipforge/shared/clip-topics";
import { CLIP_DETECTION_CONFIG } from "./ranking-config.js";

export interface TopicSentence {
  start: number;
  end: number;
  text: string;
}

export interface TopicSegmentation {
  topics: ClipTopicSegment[];
  sentenceTopicIndices: number[];
  sentenceCoherenceScores: number[];
  boundarySimilarities: number[];
  boundaryDepthScores: number[];
}

export interface TopicSegmentationOutcome {
  topics: ClipTopicSegment[];
  mode: "semantic" | "basic";
  warning?: string;
  embeddingError?: string;
}

export async function segmentTopicsWithFallback(
  sentences: TopicSentence[],
  embed: () => Promise<number[][]>
): Promise<TopicSegmentationOutcome> {
  try {
    const embeddings = await embed();
    return {
      topics: segmentTranscriptTopics(sentences, embeddings).topics,
      mode: "semantic"
    };
  } catch (error) {
    return {
      topics: fallbackHeuristicTopicSegments(sentences),
      mode: "basic",
      warning: "Topics: basic mode, embedding model unavailable",
      embeddingError: error instanceof Error ? error.message : "Unknown embedding error"
    };
  }
}

const stopWords = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "because",
  "been", "before", "being", "but", "by", "can", "could", "did", "do", "does", "for", "from", "had", "has",
  "have", "he", "her", "here", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "like",
  "me", "more", "most", "my", "no", "not", "of", "on", "one", "or", "our", "out", "she", "so", "some", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "too", "up", "us",
  "very", "was", "we", "were", "what", "when", "where", "which", "who", "will", "with", "would", "you", "your",
  "re", "ve", "ll", "don", "dont", "isn", "aren", "wasn", "weren", "didn", "doesn", "didnt", "havent", "hasnt",
  "hadnt", "cant", "couldnt", "shouldnt", "wouldnt", "wont", "im", "ive", "youre", "youve", "theyre", "theyve",
  "weve", "were", "thatll", "thisll", "theres", "theres", "isnt", "arent", "werent", "didnt",
  "going", "know", "want", "right", "yeah", "really", "think", "thing",
  "और", "है", "हैं", "था", "थे", "थी", "की", "के", "का", "को", "से", "में", "पर", "यह", "वह", "वो",
  "हम", "आप", "मैं", "क्या", "तो", "भी", "एक", "नहीं", "कर", "करता", "करती", "करने", "था", "थे"
]);

function normalizeTopicToken(word: string) {
  return word.replace(/['’]/gu, "").toLocaleLowerCase();
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function meanVector(vectors: number[][], start: number, end: number) {
  const dimensions = vectors[0]?.length ?? 0;
  const mean = Array.from({ length: dimensions }, () => 0);
  for (let index = start; index < end; index += 1) {
    const vector = vectors[index]!;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      mean[dimension]! += vector[dimension]!;
    }
  }
  const count = Math.max(1, end - start);
  return mean.map((value) => value / count);
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function topicTokens(text: string) {
  const raw = [...text.toLocaleLowerCase().matchAll(/[\p{L}\p{M}\p{N}]+/gu)]
    .map((match) => normalizeTopicToken(match[0] ?? ""));
  return raw.filter((word) => word.length >= 3 && !stopWords.has(word) && !/^\d+$/u.test(word));
}

export function topicLabel(text: string, index: number, docTexts: string[]) {
  const docs = docTexts.length > 0 ? docTexts : [text];
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const word of topicTokens(doc)) {
      if (!seen.has(word)) {
        seen.add(word);
        documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
      }
    }
  }
  const counts = new Map<string, number>();
  for (const word of topicTokens(text)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const keywords = [...counts.entries()]
    .map(([word, frequency]) => ({ word, score: frequency * (Math.log((docs.length + 1) / ((documentFrequency.get(word) ?? 1) + 1)) + 1) }))
    .sort((left, right) => right.score - left.score || left.word.localeCompare(right.word))
    .slice(0, 3)
    .map(({ word }) => word);
  return keywords.length > 0 ? keywords.join(" · ") : `Topic ${index + 1}`;
}

function buildBoundarySimilarities(embeddings: number[][]) {
  const similarities = Array.from({ length: Math.max(0, embeddings.length - 1) }, () => 1);
  const windowSize = CLIP_DETECTION_CONFIG.topicWindowSentences;
  for (let boundary = windowSize; boundary <= embeddings.length - windowSize; boundary += 1) {
    const left = meanVector(embeddings, boundary - windowSize, boundary);
    const right = meanVector(embeddings, boundary, boundary + windowSize);
    similarities[boundary - 1] = cosineSimilarity(left, right);
  }

  const depthScores = Array.from({ length: similarities.length }, () => 0);
  for (let boundary = 1; boundary < similarities.length - 1; boundary += 1) {
    const previous = similarities[boundary - 1] ?? similarities[boundary] ?? 0;
    const next = similarities[boundary + 1] ?? similarities[boundary] ?? 0;
    const current = similarities[boundary] ?? 0;
    depthScores[boundary] = Math.max(0, ((previous + next) / 2) - current);
  }
  return { similarities, depthScores };
}

function findBoundaries(similarities: number[], depthScores: number[], sentenceCount: number, totalDurationSeconds: number) {
  const minimum = CLIP_DETECTION_CONFIG.minimumTopicSentences;
  const targetTopics = Math.max(2, Math.min(8, Math.ceil(Math.max(60, totalDurationSeconds) / CLIP_DETECTION_CONFIG.targetTopicSeconds)));
  const targetGap = Math.max(minimum, Math.round(sentenceCount / targetTopics));
  const minGap = Math.max(minimum, Math.round(targetGap * 0.6));
  const threshold = Math.max(0, mean(depthScores) - CLIP_DETECTION_CONFIG.topicDepthSensitivity * standardDeviation(depthScores));
  const candidates: Array<{ boundary: number; depth: number }> = [];
  for (let boundary = minGap; boundary <= sentenceCount - minGap; boundary += 1) {
    const score = similarities[boundary - 1];
    const previous = similarities[boundary - 2] ?? score;
    const next = similarities[boundary] ?? score;
    const depth = depthScores[boundary - 1] ?? 0;
    if (score === undefined || previous === undefined || next === undefined) continue;
    if (depth < threshold) continue;
    if (score > previous || score > next) continue;
    if (score >= CLIP_DETECTION_CONFIG.topicSimilarityThreshold) continue;
    candidates.push({ boundary, depth });
  }

  const selected: number[] = [];
  for (const candidate of candidates.sort((left, right) => right.depth - left.depth || left.boundary - right.boundary)) {
    if (selected.some((existing) => Math.abs(existing - candidate.boundary) < minGap)) continue;
    selected.push(candidate.boundary);
  }
  return selected.sort((left, right) => left - right);
}

function applyDurationChecks(sentences: TopicSentence[], boundaries: number[]): number[] {
  const minLengthSeconds = CLIP_DETECTION_CONFIG.minimumTopicSeconds;
  const maxLengthSeconds = CLIP_DETECTION_CONFIG.maximumTopicSeconds;
  let current = [...boundaries];
  let changed = true;

  for (let pass = 0; pass < 4 && changed; pass += 1) {
    changed = false;
    const segments = [0, ...current, sentences.length];

    for (let index = 0; index < segments.length - 1; index += 1) {
      const startIndex = segments[index]!;
      const endIndex = segments[index + 1]!;
      const segmentStart = sentences[startIndex]?.start ?? 0;
      const segmentEnd = sentences[Math.max(0, endIndex - 1)]?.end ?? segmentStart;
      const segmentDuration = segmentEnd - segmentStart;

      if (segmentDuration > maxLengthSeconds && endIndex - startIndex > 1) {
        const splitAt = Math.floor((startIndex + endIndex) / 2);
        if (splitAt > startIndex && splitAt < endIndex) {
          current = [...current, splitAt].sort((left, right) => left - right);
          changed = true;
          break;
        }
      }

      if (segmentDuration < minLengthSeconds && index + 1 < segments.length - 1) {
        const nextBoundary = segments[index + 2];
        if (nextBoundary !== undefined && current.includes(nextBoundary)) {
          current = current.filter((value) => value !== nextBoundary);
          changed = true;
          break;
        }
      }
    }
  }

  return current;
}

export function fallbackHeuristicTopicSegments(sentences: TopicSentence[]): ClipTopicSegment[] {
  if (sentences.length === 0) return [];
  const minSeconds = CLIP_DETECTION_CONFIG.minimumTopicSeconds;
  const maxSeconds = CLIP_DETECTION_CONFIG.maximumTopicSeconds;
  const targetSeconds = CLIP_DETECTION_CONFIG.targetTopicSeconds;
  const topics: ClipTopicSegment[] = [];
  let segmentStart = 0;

  for (let index = 1; index <= sentences.length; index += 1) {
    const previous = sentences[index - 1] ?? null;
    const current = sentences[index] ?? null;
    const segmentStartTime = sentences[segmentStart]?.start ?? previous?.start ?? 0;
    const segmentDuration = (previous?.end ?? segmentStartTime) - segmentStartTime;
    const naturalBoundary = Boolean(
      previous && current && (
        current.start - previous.end >= 0.9 || /[?!。！？]/u.test(previous.text.trim().slice(-1))
      )
    );
    const shouldSplit = index === sentences.length || (
      segmentDuration >= maxSeconds ||
      (segmentDuration >= targetSeconds && naturalBoundary && index - segmentStart > 1)
    );

    if (shouldSplit) {
      const group = sentences.slice(segmentStart, index);
      if (group.length > 0) {
        const text = group.map((sentence) => sentence.text).join(" ").trim();
        const start = group[0]!.start;
        const end = group.at(-1)!.end;
        topics.push({
          id: `topic-${topics.length + 1}`,
          index: topics.length,
          start,
          end,
          label: topicLabel(text, topics.length, [text]),
          text: text.slice(0, 20_000),
          boundaryDepthScore: 0,
          contextBefore: sentences.slice(Math.max(0, segmentStart - 3), segmentStart).map((sentence) => sentence.text).slice(-3),
          contextAfter: sentences.slice(index, Math.min(sentences.length, index + 3)).map((sentence) => sentence.text).slice(0, 3)
        });
      }
      if (index < sentences.length) {
        segmentStart = index;
      }
    }

    if (segmentDuration < minSeconds && index < sentences.length) {
      continue;
    }
  }

  return topics;
}

export function segmentTranscriptTopics(
  sentences: TopicSentence[],
  embeddings: number[][]
): TopicSegmentation {
  if (sentences.length === 0 || sentences.length !== embeddings.length) {
    throw new Error("Topic segmentation requires one embedding for every transcript sentence");
  }
  const totalDurationSeconds = Math.max(0, (sentences.at(-1)?.end ?? 0) - (sentences[0]?.start ?? 0));
  const { similarities, depthScores } = buildBoundarySimilarities(embeddings);
  const rawBoundaries = findBoundaries(similarities, depthScores, sentences.length, totalDurationSeconds);
  const boundaries = applyDurationChecks(sentences, rawBoundaries);
  const topicBoundaries = [0, ...boundaries, sentences.length];
  const topics: ClipTopicSegment[] = [];
  const sentenceTopicIndices = Array.from({ length: sentences.length }, () => 0);
  const sentenceCoherenceScores = Array.from({ length: sentences.length }, () => 100);
  const topicTexts = [] as string[];

  for (let topicIndex = 0; topicIndex < topicBoundaries.length - 1; topicIndex += 1) {
    const startIndex = topicBoundaries[topicIndex]!;
    const endIndex = topicBoundaries[topicIndex + 1]!;
    const group = sentences.slice(startIndex, endIndex);
    if (group.length === 0) continue;
    const centroid = meanVector(embeddings, startIndex, endIndex);
    const coherence = group.map((_, offset) => {
      const score = Math.round(((cosineSimilarity(embeddings[startIndex + offset]!, centroid) + 1) / 2) * 100);
      sentenceTopicIndices[startIndex + offset] = topicIndex;
      sentenceCoherenceScores[startIndex + offset] = Math.max(0, Math.min(100, score));
      return score;
    });
    const text = group.map((sentence) => sentence.text).join(" ").trim();
    topicTexts.push(text);
    const fieldDepth = startIndex === 0 ? 0 : (depthScores[Math.max(0, startIndex - 1)] ?? 0);
    topics.push({
      id: `topic-${topicIndex + 1}`,
      index: topicIndex,
      start: group[0]!.start,
      end: group.at(-1)!.end,
      label: topicLabel(text, topicIndex, topicTexts),
      text: text.slice(0, 20_000),
      boundaryDepthScore: Number(fieldDepth.toFixed(4)),
      contextBefore: sentences.slice(Math.max(0, startIndex - 3), startIndex).map((sentence) => sentence.text).slice(-3),
      contextAfter: sentences.slice(endIndex, Math.min(sentences.length, endIndex + 3)).map((sentence) => sentence.text).slice(0, 3)
    });
    if (coherence.length === 0) throw new Error("Topic segmentation produced an empty topic");
  }

  return {
    topics,
    sentenceTopicIndices,
    sentenceCoherenceScores,
    boundarySimilarities: similarities,
    boundaryDepthScores: depthScores
  };
}
