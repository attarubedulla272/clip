import { z } from "zod";
import { PLATFORM_LIMITS } from "./platform-limits.js";

export const trendSampleSchema = z.object({
  title: z.string().trim().min(1).max(500),
  url: z.string().url().startsWith("https://www.youtube.com/watch?v="),
  videoId: z.string().min(1).max(100),
  tags: z.array(z.string()).default([]),
  viewCount: z.number().int().min(0).default(0),
  publishedAt: z.string().datetime().optional()
});

export const trendSignalsSchema = z.object({
  mode: z.enum(["online", "offline"]),
  badge: z.enum(["Trend data: online", "Trend data: offline"]),
  queries: z.array(z.string()).min(1).max(3),
  samples: z.array(trendSampleSchema).max(8).default([]),
  topKeywords: z.array(z.string()).max(20).default([]),
  commonHashtags: z.array(z.string()).max(20).default([]),
  fetchedAt: z.string().datetime(),
  regionCode: z.string().length(2),
  relevanceLanguage: z.string().min(2).max(10),
  quotaUsedToday: z.number().int().min(0),
  quotaRemaining: z.number().int().min(0),
  fallbackReason: z.string().optional()
});

export type TrendSignals = z.infer<typeof trendSignalsSchema>;

export const metadataOptionsSchema = z.object({
  language: z.enum(["same", "english"]).default("same"),
  tone: z.enum(["curious", "direct", "informative"]).default("curious"),
  includeOriginalCredit: z.boolean().default(true),
  useGemini: z.boolean().default(false)
});

export const clipMetadataResultSchema = z.object({
  youtube: z.object({
    titleVariants: z.array(z.string().trim().min(1).max(PLATFORM_LIMITS.youtubeShorts.titleCharacters)).length(3),
    selectedTitleIndex: z.number().int().min(0).max(2).default(0),
    description: z.string().trim().min(1).max(PLATFORM_LIMITS.youtubeShorts.descriptionCharacters),
    tags: z.array(z.string().trim().min(1).max(PLATFORM_LIMITS.youtubeShorts.tagCharacters))
      .min(PLATFORM_LIMITS.youtubeShorts.tagCount.min).max(PLATFORM_LIMITS.youtubeShorts.tagCount.max),
    hashtags: z.array(z.string().regex(/^#[\p{L}\p{M}\p{N}_]+$/u).max(PLATFORM_LIMITS.youtubeShorts.hashtagCharacters))
      .min(PLATFORM_LIMITS.youtubeShorts.hashtagCount.min).max(PLATFORM_LIMITS.youtubeShorts.hashtagCount.max)
  }),
  instagramReels: z.object({
    caption: z.string().trim().min(1).max(PLATFORM_LIMITS.instagramReels.captionCharacters)
  }),
  tiktok: z.object({
    caption: z.string().trim().min(1).max(PLATFORM_LIMITS.tiktok.captionCharacters)
  })
});

export const clipMetadataTitlesAndTagsSchema = clipMetadataResultSchema.shape.youtube.pick({
  titleVariants: true,
  selectedTitleIndex: true,
  tags: true
});

export const clipMetadataDescriptionSchema = clipMetadataResultSchema.shape.youtube.pick({
  description: true
});

export const clipMetadataHashtagsSchema = clipMetadataResultSchema.shape.youtube.pick({
  tags: true,
  hashtags: true
});

export const clipMetadataTitleSchema = z.object({
  title: z.string().trim().min(1).max(PLATFORM_LIMITS.youtubeShorts.titleCharacters)
});

export const clipMetadataTitlesSchema = clipMetadataResultSchema.shape.youtube.pick({
  titleVariants: true,
  selectedTitleIndex: true
});

export const clipMetadataPlatformCaptionsSchema = clipMetadataResultSchema.pick({
  instagramReels: true,
  tiktok: true
});

export const clipMetadataDocumentSchema = z.object({
  contentHash: z.string().regex(/^[a-f\d]{64}$/i),
  result: clipMetadataResultSchema,
  mode: z.enum(["AI", "Offline"]),
  provider: z.enum(["Gemini", "Ollama", "Offline", "Gemini + Offline", "Ollama + Offline"]).optional(),
  warnings: z.record(z.string(), z.array(z.string())).optional(),
  language: metadataOptionsSchema.shape.language,
  tone: metadataOptionsSchema.shape.tone,
  includeOriginalCredit: z.boolean(),
  useGemini: z.boolean().default(false),
  generationStatus: z.enum(["idle", "queued", "processing", "retrying", "failed"]).default("idle"),
  generationJobId: z.string().optional(),
  generationProgress: z.object({
    message: z.string(),
    percent: z.number().min(0).max(100),
    etaSeconds: z.number().min(0).optional()
  }).optional(),
  generationError: z.string().max(1000).optional()
});

export type MetadataOptions = z.infer<typeof metadataOptionsSchema>;
export type ClipMetadataResult = z.infer<typeof clipMetadataResultSchema>;
export type ClipMetadataDocument = z.infer<typeof clipMetadataDocumentSchema>;

export const TREND_CONFIG = {
  cacheTtlHours: 24,
  safetyStopFraction: 0.8,
  youtubeSearchListCost: 100,
  youtubeVideosListCost: 1,
  maxQueriesPerClip: 3,
  titleOverlapThreshold: 0.6,
  defaultRegionCode: "IN"
} as const;

export function deriveTrendQueries(text: string, topicLabel: string, videoType: string, limit = TREND_CONFIG.maxQueriesPerClip) {
  const keywords = extractSignificantKeywords(`${text} ${topicLabel} ${videoType}`, 12);
  const primary = keywords.slice(0, 3);
  const queries = [
    primary.slice(0, 2).join(" "),
    primary.slice(0, 3).join(" "),
    `${topicLabel} ${primary[0] ?? videoType}`.trim()
  ].map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean);
  return [...new Set(queries)].slice(0, limit);
}

export function titleWordOverlap(title: string, competitors: string[]) {
  const words = title.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const titleSet = new Set(words);
  if (titleSet.size === 0) return 0;
  for (const competitor of competitors) {
    const competitorWords = new Set((competitor.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []));
    let overlap = 0;
    for (const word of titleSet) if (competitorWords.has(word)) overlap += 1;
    const ratio = overlap / titleSet.size;
    if (ratio >= TREND_CONFIG.titleOverlapThreshold) return ratio;
  }
  return 0;
}

const bannedPattern = /\b(?:guarantee(?:d)?|promise(?:d)?|will\s+go\s+viral|go\s+viral|viral|blow\s+up|millions?\s+of\s+views|you\s+won['’]?t\s+believe|limited\s+time|limited\s+offer|act\s+now|last\s+chance|hurry|urgent|ending\s+soon|don['’]?t\s+miss\s+out|before\s+it['’]?s\s+too\s+late|shocking\s+secret)\b/i;
const allowedNonFactualTerms = new Set([
  "about", "after", "before", "because", "clip", "video", "discover", "follow", "for", "from", "here", "idea",
  "learn", "more", "part", "share", "short", "subscribe", "this", "today", "watch", "with",
  "insight", "explained", "guide", "thought", "story", "moment", "key", "takeaway", "explore",
  "closer", "look", "discusses", "themes", "ideas", "topic", "shorts", "focused", "विचारों",
  "stays", "ऐसे", "और", "के", "लिए", "फ़ॉलो", "करें", "మరిన్ని", "విషయాల", "కోసం", "ఫాలో", "అవ్వండి"
]);

function normalizedWords(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function hasAllCapsSpam(text: string) {
  const words = text.match(/[A-Za-z]{4,}/g) ?? [];
  return words.length > 0 && words.filter((word) => word === word.toUpperCase()).length / words.length > 0.6;
}

function stemWord(word: string) {
  if (!/^[a-z]+$/i.test(word)) return word;
  const lower = word.toLocaleLowerCase();
  for (const suffix of ["ations", "ation", "ences", "ance", "ence", "ments", "ment", "ness", "ies", "ing", "ed", "ant", "s"]) {
    if (lower.length > suffix.length + 2 && lower.endsWith(suffix)) {
      return lower.slice(0, -suffix.length) + (suffix === "ies" ? "y" : "");
    }
  }
  return lower;
}

export function extractSignificantKeywords(transcript: string, limit = 12) {
  const stopWords = new Set([
    "about", "after", "again", "also", "and", "are", "because", "been", "before", "but", "can", "could",
    "did", "does", "for", "from", "have", "her", "here", "him", "his", "how", "into", "its", "just",
    "like", "more", "most", "not", "our", "out", "over", "she", "some", "than", "that", "the", "their",
    "them", "then", "there", "these", "they", "this", "those", "through", "too", "very", "was", "were",
    "what", "when", "where", "which", "who", "will", "with", "would", "you", "your"
  ]);
  const counts = new Map<string, number>();
  for (const word of normalizedWords(transcript)) {
    if (word.length < 3 || stopWords.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([word]) => word);
}

function unsupportedTranscriptTerms(text: string, source: string) {
  const sourceWords = new Set(normalizedWords(source).flatMap((word) => [word, stemWord(word)]));
  return [...new Set(normalizedWords(text).filter((word) =>
    word.length >= 5 && !allowedNonFactualTerms.has(word) &&
    !sourceWords.has(word) && !sourceWords.has(stemWord(word))
  ))];
}

const claimTerms = new Set([
  "alter", "boost", "cause", "change", "clear", "cure", "double", "earn", "ensure", "generate",
  "give", "heal", "help", "increase", "improve", "make", "organize", "prevent", "protect",
  "reduce", "save", "shift", "show", "strengthen", "suggest", "triple", "treat"
]);
const healthOrFinancialTerms = /\b(?:health\w*|immun\w*|disease\w*|cancer|cure|treatment|medical|doctor|medicine|blood|heart|brain|sleep|anxiety|depression|financial\w*|finance|money|income|profit|investment|investing|debt|wealth|returns?)\b/i;

function normalizedNumbers(text: string) {
  const numberWords: Record<string, string> = {
    zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
    seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
    twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100", thousand: "1000"
  };
  const numbers = text.toLocaleLowerCase().match(/\b\d+(?:\.\d+)?%?\b/g) ?? [];
  const words = normalizedWords(text).filter((word) => numberWords[word]).map((word) => numberWords[word]!);
  return [...numbers, ...words].map((number) => number.replace(/%$/, ""));
}

function unsupportedClaims(text: string, source: string) {
  const sourceWords = new Set(normalizedWords(source).flatMap((word) => [word, stemWord(word)]));
  const sourceNumbers = new Set(normalizedNumbers(source));
  const visibleText = text.replace(/#[\p{L}\p{M}\p{N}_]+/gu, "");
  const statements = visibleText.split(/\r?\n/).flatMap((line) => line.split(/(?<=[.!?।])\s+/u))
    .map((statement) => statement.trim())
    .filter(Boolean);
  const issues: string[] = [];
  for (const statement of statements) {
    const words = normalizedWords(statement);
    if (words.length === 0) continue;
    const unsupportedClaimWords = words.filter((word) => {
      const stem = stemWord(word);
      return claimTerms.has(stem) && !sourceWords.has(word) && !sourceWords.has(stem);
    });
    if (unsupportedClaimWords.length > 0 && healthOrFinancialTerms.test(statement)) {
      issues.push(`Contains unsupported health or financial claim wording: ${[...new Set(unsupportedClaimWords)].join(", ")}`);
    }
    const unsupportedNumbers = normalizedNumbers(statement).filter((number) => !sourceNumbers.has(number));
    if (unsupportedNumbers.length > 0) {
      issues.push(`Contains numbers not present in the transcript or source title: ${[...new Set(unsupportedNumbers)].join(", ")}`);
    }
    const quotedText = [...statement.matchAll(/["“”](.+?)["“”]/gu)].map((match) => match[1] ?? "");
    if (quotedText.some((quote) => !source.toLocaleLowerCase().includes(quote.toLocaleLowerCase()))) {
      issues.push("Contains a quote that does not appear in the transcript or source title");
    }
  }
  const properNameCandidates = [
    ...visibleText.matchAll(/\b(?:Dr|Mr|Ms|Mrs|Professor|Coach|President)\.?\s+[\p{Lu}][\p{L}\p{M}'’-]+(?:\s+[\p{Lu}][\p{L}\p{M}'’-]+)?/gu),
    ...visibleText.matchAll(/\b(?:by|from|according to|called|named|meet|host|guest)\s+([\p{Lu}][\p{L}\p{M}'’-]+\s+[\p{Lu}][\p{L}\p{M}'’-]+)\b/gu)
  ].map((match) => match[1] ?? match[0]);
  if (properNameCandidates.some((name) => !source.toLocaleLowerCase().includes(name.toLocaleLowerCase()))) {
    issues.push("Contains a name not present in the transcript or source title");
  }
  return [...new Set(issues)];
}

export interface MetadataValidationIssue {
  field: string;
  message: string;
}

export function validateMetadataRules(
  result: ClipMetadataResult,
  transcript: string,
  context: { sourceTitle: string; videoType: string; creditLine?: string }
) {
  const parsed = clipMetadataResultSchema.safeParse(result);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : "metadata",
      message: issue.message
    }));
    return { success: false as const, errors: issues.map((issue) => issue.message), issues, warnings: [] as MetadataValidationIssue[] };
  }

  const source = `${transcript} ${context.sourceTitle} ${context.videoType}`;
  const keywords = extractSignificantKeywords(transcript);
  const texts: Array<{ field: string; value: string }> = [
    ...result.youtube.titleVariants.map((value, index) => ({ field: `youtube.titleVariants.${index}`, value })),
    { field: "youtube.description", value: result.youtube.description.replace(context.creditLine ?? "\u0000", "") },
    ...result.youtube.tags.map((value, index) => ({ field: `youtube.tags.${index}`, value })),
    ...result.youtube.hashtags.map((value, index) => ({
      field: `youtube.hashtags.${index}`,
      value: value.replace(/([a-z])([A-Z])/g, "$1 $2").slice(1)
    })),
    { field: "instagramReels.caption", value: result.instagramReels.caption },
    { field: "tiktok.caption", value: result.tiktok.caption }
  ];
  const issues: MetadataValidationIssue[] = [];
  const warnings: MetadataValidationIssue[] = [];
  const addIssue = (field: string, message: string) => issues.push({ field, message });
  const addWarning = (field: string, message: string) => warnings.push({ field, message });

  for (const [index, title] of result.youtube.titleVariants.entries()) {
    if (!keywords.some((keyword) => normalizedWords(title).includes(keyword))) {
      addWarning(`youtube.titleVariants.${index}`, `Title ${index + 1} does not contain a significant keyword from the clip transcript`);
    }
  }
  for (const { field, value } of texts) {
    if (bannedPattern.test(value)) addIssue(field, "Metadata contains a guarantee, fake urgency, or viral claim");
    if (hasAllCapsSpam(value)) addIssue(field, "Metadata contains ALL-CAPS spam");
    for (const issue of unsupportedClaims(value, source)) addIssue(field, issue);
    const unsupported = unsupportedTranscriptTerms(value, source);
    if (unsupported.length > 0) {
      addWarning(field, `Contains harmless wording not found in the transcript: ${unsupported.join(", ")}`);
    }
  }
  if (result.youtube.tags.reduce((sum, tag) => sum + tag.length + 1, -1) > PLATFORM_LIMITS.youtubeShorts.totalTagCharacters) {
    addIssue("youtube.tags", `YouTube tags exceed ${PLATFORM_LIMITS.youtubeShorts.totalTagCharacters} total characters`);
  }
  if (result.youtube.description.split(/\r?\n/).length < 5) {
    addIssue("youtube.description", "The YouTube description must include two hook lines, a summary, a call to action, and hashtags on separate lines");
  }
  if (result.youtube.hashtags.some((hashtag) => !result.youtube.description.includes(hashtag))) {
    addIssue("youtube.hashtags", "Every YouTube hashtag must also appear in the description");
  }
  for (const [platform, caption] of [
    ["Instagram Reels", result.instagramReels.caption],
    ["TikTok", result.tiktok.caption]
  ] as const) {
    const hashtags = caption.match(/#[\p{L}\p{M}\p{N}_]+/gu) ?? [];
    if (hashtags.length < 3 || hashtags.length > 5) {
      const field = platform === "Instagram Reels" ? "instagramReels.caption" : "tiktok.caption";
      addIssue(field, `${platform} caption must include 3-5 hashtags`);
    }
  }
  return issues.length > 0
    ? { success: false as const, errors: issues.map((issue) => issue.message), issues, warnings }
    : { success: true as const, data: parsed.data, warnings };
}
