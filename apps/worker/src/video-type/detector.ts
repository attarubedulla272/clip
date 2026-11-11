import type { VideoType } from "@clipforge/shared";
import type { TranscriptSegment } from "../transcription/chunks.js";

export interface VideoTypeInput {
  segments: TranscriptSegment[];
  durationSeconds: number;
}

export interface VideoTypeResult {
  type: VideoType;
  speechDensityWordsPerMinute: number;
  questionRatio: number;
  meanPauseSeconds: number;
  cueCounts: Record<string, number>;
}

export interface VideoTypeDetector {
  detect(input: VideoTypeInput): VideoTypeResult;
}

const cues: Record<Exclude<VideoType, "other">, RegExp> = {
  podcast: /\b(podcast|episode|welcome back|subscribe|our guest)\b/gi,
  interview: /\b(interview|tell me about|what do you think|how did you|your experience|guest)\b/gi,
  tutorial: /\b(tutorial|step|first|next|click|install|open the|how to)\b/gi,
  vlog: /\b(vlog|today i|come with me|this morning|here we are|we went|my day)\b/gi
};

function countMatches(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].length;
}

export class HeuristicVideoTypeDetector implements VideoTypeDetector {
  detect({ segments, durationSeconds }: VideoTypeInput): VideoTypeResult {
    const text = segments.map((segment) => segment.text).join(" ");
    const words = text.match(/\b[\p{L}\p{N}'’-]+\b/gu) ?? [];
    const speechDensityWordsPerMinute = durationSeconds > 0 ? words.length * 60 / durationSeconds : 0;
    const questionCount = segments.filter((segment) => /\?\s*$/.test(segment.text.trim())).length;
    const questionRatio = segments.length > 0 ? questionCount / segments.length : 0;
    const pauses = segments.slice(1).map((segment, index) => Math.max(0, segment.start - segments[index]!.end));
    const meanPauseSeconds = pauses.length > 0 ? pauses.reduce((sum, pause) => sum + pause, 0) / pauses.length : 0;
    const cueCounts = Object.fromEntries(
      Object.entries(cues).map(([type, pattern]) => [type, countMatches(text, pattern)])
    );

    const scores: Record<Exclude<VideoType, "other">, number> = {
      podcast: (cueCounts.podcast ?? 0) * 2 + (speechDensityWordsPerMinute >= 90 ? 1 : 0),
      interview: (cueCounts.interview ?? 0) * 2 + questionRatio * 6 + (segments.length >= 5 ? 1 : 0),
      tutorial: (cueCounts.tutorial ?? 0) * 2 + (/\b(first|then|finally)\b/i.test(text) ? 1 : 0),
      vlog: (cueCounts.vlog ?? 0) * 2 + (meanPauseSeconds > 1.2 ? 0.5 : 0)
    };
    const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
    const type = (ranked[0]?.[1] ?? 0) >= 2 ? ranked[0]![0] as VideoType : "other";

    return {
      type,
      speechDensityWordsPerMinute: Math.round(speechDensityWordsPerMinute * 10) / 10,
      questionRatio: Math.round(questionRatio * 1_000) / 1_000,
      meanPauseSeconds: Math.round(meanPauseSeconds * 1_000) / 1_000,
      cueCounts
    };
  }
}
