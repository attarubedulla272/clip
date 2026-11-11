export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  probability?: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptChunk {
  offsetSeconds: number;
  words: TranscriptWord[];
  segments: TranscriptSegment[];
}

export interface MergedTranscript {
  words: TranscriptWord[];
  segments: TranscriptSegment[];
}

export function mergeChunkTranscripts(chunks: TranscriptChunk[]): MergedTranscript {
  const words = chunks.flatMap(({ offsetSeconds, words: chunkWords }) =>
    chunkWords.map((word) => ({
      ...word,
      start: Math.max(0, word.start + offsetSeconds),
      end: Math.max(0, word.end + offsetSeconds)
    }))
  ).sort((left, right) => left.start - right.start);
  const segments = chunks.flatMap(({ offsetSeconds, segments: chunkSegments }) =>
    chunkSegments.map((segment) => ({
      ...segment,
      start: Math.max(0, segment.start + offsetSeconds),
      end: Math.max(0, segment.end + offsetSeconds)
    }))
  ).sort((left, right) => left.start - right.start);
  return { words, segments };
}
