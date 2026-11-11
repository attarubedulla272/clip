export interface WordBoundary {
  start: number;
  end: number;
}

export interface TimedTranscriptWord extends WordBoundary {
  text: string;
  probability?: number;
}

export type ClipEdge = "start" | "end";

export function parseTranscriptWords(values: unknown[]): {
  words: TimedTranscriptWord[];
  skippedZeroDurationWords: number;
} {
  const words: TimedTranscriptWord[] = [];
  let skippedZeroDurationWords = 0;
  for (const [index, value] of values.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Saved transcript word ${index + 1} is invalid`);
    }
    const word = value as Record<string, unknown>;
    if (typeof word.text !== "string" || typeof word.start !== "number" || typeof word.end !== "number" ||
      !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0) {
      throw new Error(`Saved transcript word ${index + 1} has invalid text or timestamps`);
    }
    if (word.end <= word.start) {
      skippedZeroDurationWords += 1;
      continue;
    }
    words.push({
      text: word.text,
      start: word.start,
      end: word.end,
      ...(typeof word.probability === "number" ? { probability: word.probability } : {})
    });
  }
  return { words, skippedZeroDurationWords };
}

export function snapToWordBoundary(seconds: number, words: WordBoundary[], edge: ClipEdge): number {
  if (!Number.isFinite(seconds)) throw new Error("Trim time must be a finite number");
  if (words.length === 0) throw new Error("Word timestamps are required to snap a trim");

  const boundaries = words
    .map((word) => edge === "start" ? word.start : word.end)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (boundaries.length === 0) throw new Error("No valid word boundaries are available");

  return boundaries.reduce((nearest, boundary) =>
    Math.abs(boundary - seconds) < Math.abs(nearest - seconds) ? boundary : nearest
  );
}

export function nudgeClipEdge(
  start: number,
  end: number,
  edge: ClipEdge,
  direction: -1 | 1,
  durationSeconds: number,
  words: WordBoundary[],
  stepSeconds = 0.5
): { start: number; end: number } {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Video duration must be positive");
  }
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) {
    throw new Error("Nudge step must be positive");
  }

  const current = edge === "start" ? start : end;
  const requested = Math.max(0, Math.min(durationSeconds, current + direction * stepSeconds));
  const candidates = words
    .map((word) => edge === "start" ? word.start : word.end)
    .filter((boundary) => Number.isFinite(boundary) && (direction > 0 ? boundary > current : boundary < current))
    .sort((left, right) => left - right);
  if (candidates.length === 0) {
    throw new RangeError(`There is no word boundary to move the ${edge} ${direction > 0 ? "later" : "earlier"}`);
  }
  const snapped = candidates.reduce((nearest, boundary) =>
    Math.abs(boundary - requested) < Math.abs(nearest - requested) ? boundary : nearest
  );
  const next = edge === "start" ? { start: snapped, end } : { start, end: snapped };
  if (next.start < 0 || next.end > durationSeconds || next.start >= next.end) {
    throw new RangeError("The trim must stay within the video and keep a positive duration");
  }
  return next;
}
