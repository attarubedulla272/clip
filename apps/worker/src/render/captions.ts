import type { TimedTranscriptWord } from "@clipforge/shared/clip-trim";
import {
  CAPTION_CONFIG,
  CAPTION_STYLE_CONFIG,
  type CaptionStyle
} from "@clipforge/shared/caption-config";

export interface CaptionChunk {
  words: TimedTranscriptWord[];
  start: number;
  end: number;
}

export function getCaptionPreviewRange(start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error("Caption preview boundaries must be valid");
  }
  return { start, end: Math.min(end, start + CAPTION_CONFIG.previewSeconds) };
}

function normalizedToken(text: string) {
  return text.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function hasPhrasePunctuation(text: string) {
  return /[,;:.!?।]["'”’)\]]*$/.test(text.trim());
}

export function cleanCaptionFillers(words: TimedTranscriptWord[]) {
  const cleaned: TimedTranscriptWord[] = [];
  let previousToken = "";
  for (const word of words) {
    const token = normalizedToken(word.text);
    if (CAPTION_CONFIG.fillerWords.includes(token as "um" | "uh")) continue;
    if (
      token.length >= CAPTION_CONFIG.duplicateComparisonMinimumLength &&
      token === previousToken
    ) continue;
    cleaned.push(word);
    if (token) previousToken = token;
  }
  return cleaned;
}

export function normalizeCaptionTimings(
  words: TimedTranscriptWord[],
  clipStart: number,
  clipEnd: number
) {
  const ordered = [...words]
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) &&
      word.end > word.start && word.end > clipStart && word.start < clipEnd)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const normalized: TimedTranscriptWord[] = [];
  let previousEnd = clipStart;

  for (let index = 0; index < ordered.length; index += 1) {
    const word = ordered[index]!;
    const next = ordered[index + 1];
    const start = Math.max(clipStart, word.start, previousEnd);
    const availableEnd = Math.min(clipEnd, word.end, next?.start ?? clipEnd);
    if (availableEnd - start < CAPTION_CONFIG.minimumWordDurationSeconds) continue;
    const end = Math.max(
      availableEnd,
      Math.min(clipEnd, start + CAPTION_CONFIG.minimumWordDurationSeconds)
    );
    if (end <= start || end - start < CAPTION_CONFIG.minimumWordDurationSeconds) continue;
    normalized.push({ ...word, start, end });
    previousEnd = end;
  }
  return normalized;
}

export function chunkCaptionWords(words: TimedTranscriptWord[]): CaptionChunk[] {
  const chunks: CaptionChunk[] = [];
  let current: TimedTranscriptWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      words: current,
      start: current[0]!.start,
      end: current.at(-1)!.end
    });
    current = [];
  };

  for (const [index, word] of words.entries()) {
    const previous = current.at(-1);
    const pause = previous ? word.start - previous.end : 0;
    const reachesMinimum = current.length >= CAPTION_CONFIG.chunkMinimumWords;
    if (current.length > 0 &&
      (current.length >= CAPTION_CONFIG.chunkMaximumWords ||
        (reachesMinimum && (pause >= CAPTION_CONFIG.pauseBreakSeconds || hasPhrasePunctuation(previous!.text))))) {
      flush();
    }
    current.push(word);
    if (index === words.length - 1) flush();
  }
  const last = chunks.at(-1);
  const previous = chunks.at(-2);
  if (last && previous && last.words.length < CAPTION_CONFIG.chunkMinimumWords) {
    const needed = CAPTION_CONFIG.chunkMinimumWords - last.words.length;
    if (previous.words.length - needed >= CAPTION_CONFIG.chunkMinimumWords) {
      last.words.unshift(...previous.words.splice(-needed));
      last.start = last.words[0]!.start;
      previous.end = previous.words.at(-1)!.end;
    } else if (previous.words.length + last.words.length <= CAPTION_CONFIG.chunkMaximumWords) {
      previous.words.push(...last.words);
      previous.end = previous.words.at(-1)!.end;
      chunks.pop();
    }
  }
  return chunks;
}

function emphasisScore(
  word: TimedTranscriptWord,
  index: number,
  words: TimedTranscriptWord[],
  medianDuration: number
) {
  const token = normalizedToken(word.text);
  let score = 0;
  if (/\p{N}/u.test(token)) score += 5;
  if ((CAPTION_CONFIG.strongVerbs as readonly string[]).includes(token)) score += 3;
  if ((CAPTION_CONFIG.strongNouns as readonly string[]).includes(token)) score += 3;
  if (index > 0 && word.start - words[index - 1]!.end >= CAPTION_CONFIG.longPauseSeconds) score += 2;
  if (word.end - word.start >= medianDuration * CAPTION_CONFIG.slowWordMedianMultiplier) score += 2;
  return score;
}

export function selectEmphasisWordIndexes(words: TimedTranscriptWord[]) {
  const maximum = Math.floor(words.length * CAPTION_CONFIG.emphasisMaximumFraction);
  if (maximum <= 0) return new Set<number>();
  const durations = words.map((word) => word.end - word.start).sort((left, right) => left - right);
  const medianDuration = durations[Math.floor(durations.length / 2)] ?? 0;
  return new Set(words
    .map((word, index) => ({ index, score: emphasisScore(word, index, words, medianDuration) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maximum)
    .map((entry) => entry.index));
}

function formatAssTime(seconds: number) {
  const centiseconds = Math.max(0, Math.floor(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const wholeSeconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

export function escapeAssText(text: string) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/[{}\r\n]/g, (character) => {
      if (character === "{") return "\\{";
      if (character === "}") return "\\}";
      return " ";
    });
}

function styleLine(style: CaptionStyle) {
  const preset = CAPTION_STYLE_CONFIG[style];
  const bold = preset.bold ? -1 : 0;
  return `Style: Default,Noto Sans,${preset.fontSize},&H00FFFFFF,${CAPTION_CONFIG.highlightColor},&H00101010,&H80000000,${bold},0,0,0,100,100,0,0,1,${CAPTION_CONFIG.outlinePixels},${CAPTION_CONFIG.shadowPixels},2,70,70,${CAPTION_CONFIG.bottomSafeMarginPixels},1`;
}

function inlineChunkText(
  chunk: TimedTranscriptWord[],
  style: CaptionStyle,
  emphasis: Set<number>,
  globalIndexes: Map<TimedTranscriptWord, number>
) {
  let text = "";
  for (const [index, word] of chunk.entries()) {
    if (index > 0 && index % CAPTION_CONFIG.lineMaximumWords === 0) text += "\\N";
    const raw = escapeAssText(word.text);
    const wordIndex = globalIndexes.get(word) ?? -1;
    if (style === "karaoke") {
      const duration = Math.max(8, Math.round((word.end - word.start) * 100));
      text += `{\\kf${duration}}${raw}`;
    } else if (style === "bold-pop" && emphasis.has(wordIndex)) {
      const scale = CAPTION_CONFIG.emphasisScalePercent;
      text += `{\\fscx${scale}\\fscy${scale}\\t(0,${CAPTION_CONFIG.emphasisPopMilliseconds},\\fscx100\\fscy100)}${raw}{\\fscx100\\fscy100}`;
    } else {
      text += raw;
    }
  }
  return text;
}

export function generateAssSubtitles(
  words: TimedTranscriptWord[],
  clipStart: number,
  clipEnd: number,
  style: CaptionStyle = "clean",
  cleanupFillers = true
) {
  if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd) || clipStart < 0 || clipEnd <= clipStart) {
    throw new Error("Subtitle clip boundaries must be valid");
  }

  const selected = normalizeCaptionTimings(
    cleanupFillers ? cleanCaptionFillers(words) : words,
    clipStart,
    clipEnd
  );
  const chunks = chunkCaptionWords(selected);
  const emphasis = selectEmphasisWordIndexes(selected);
  const globalIndexes = new Map(selected.map((word, index) => [word, index]));
  let previousEnd = 0;
  const dialogue = chunks.map((chunk) => {
    const start = Math.max(0, previousEnd, chunk.start - clipStart - CAPTION_CONFIG.leadInSeconds);
    const end = Math.min(clipEnd - clipStart, chunk.end - clipStart);
    previousEnd = end;
    const text = inlineChunkText(chunk.words, style, emphasis, globalIndexes);
    const animated = style === "karaoke"
      ? `{\\fad(${CAPTION_CONFIG.fadeInMilliseconds},0)\\fscx108\\fscy108\\t(0,${CAPTION_CONFIG.emphasisPopMilliseconds},\\fscx100\\fscy100)}`
      : "";
    return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${animated}${text}`;
  });

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleLine(style),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...dialogue,
    ""
  ].join("\n");
}
