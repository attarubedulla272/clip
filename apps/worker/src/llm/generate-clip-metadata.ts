import { createHash } from "node:crypto";
import {
  clipMetadataDescriptionSchema,
  clipMetadataHashtagsSchema,
  clipMetadataPlatformCaptionsSchema,
  clipMetadataResultSchema,
  clipMetadataTitleSchema,
  clipMetadataTitlesSchema,
  extractSignificantKeywords,
  titleWordOverlap,
  validateMetadataRules,
  type ClipMetadataResult,
  type MetadataOptions
} from "@clipforge/shared/clip-metadata";
import type { ClipMetadataPart, ClipMetadataPromptInput } from "./llm-provider.js";

export interface ClipMetadataInput extends ClipMetadataPromptInput {
  includeOriginalCredit: boolean;
  useGemini: boolean;
}

export interface ClipMetadataCache {
  get(contentHash: string): Promise<{
    result: ClipMetadataResult;
    mode: "AI" | "Offline";
    provider?: MetadataResultProvider;
    fallbackReason?: string;
    warnings?: Record<string, string[]>;
  } | undefined>;
  set(contentHash: string, value: {
    result: ClipMetadataResult;
    mode: "AI" | "Offline";
    provider: MetadataResultProvider;
    fallbackReason?: string;
    warnings: Record<string, string[]>;
  }): Promise<void>;
}

export interface ClipMetadataGeneration {
  contentHash: string;
  result: ClipMetadataResult;
  mode: "AI" | "Offline";
  provider: MetadataResultProvider;
  cached: boolean;
  fallbackReason?: string;
  warnings: Record<string, string[]>;
}

export type MetadataProvider = {
  providerName: "Gemini" | "Ollama";
  modelName: string;
  generateMetadataPartJson(input: ClipMetadataPromptInput, part: ClipMetadataPart): Promise<string>;
};
export type MetadataResultProvider = "Gemini" | "Ollama" | "Offline" | "Gemini + Offline" | "Ollama + Offline";

function createCreditLine(input: ClipMetadataInput) {
  if (!input.includeOriginalCredit || !input.originalCredit) return undefined;
  return `Original video: ${input.originalCredit}`;
}

export function clipMetadataContentHash(input: ClipMetadataInput, modelName: string) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    modelName,
    transcript: input.transcript.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
    videoTitle: input.videoTitle.trim(),
    videoType: input.videoType,
    language: input.language,
    tone: input.tone,
    useGemini: input.useGemini,
    trend: input.trendSignals ? {
      mode: input.trendSignals.mode,
      queries: input.trendSignals.queries,
      keywords: input.trendSignals.topKeywords,
      hashtags: input.trendSignals.commonHashtags
    } : null,
    credit: createCreditLine(input) ?? ""
  })).digest("hex");
}

function appendCredit(result: ClipMetadataResult, creditLine?: string) {
  if (!creditLine) return result;
  return {
    ...result,
    youtube: {
      ...result.youtube,
      description: `${result.youtube.description.trim()}\n${creditLine}`
    }
  };
}

function cleanTranscript(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function sentenceParts(text: string) {
  const sentences = text.match(/[^.!?।]+[.!?।]?/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  return sentences.length > 0 ? sentences : [text.trim()].filter(Boolean);
}

function truncate(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  const shortened = text.slice(0, maxLength - 1).replace(/\s+\S*$/, "").trim();
  return `${shortened || text.slice(0, maxLength - 1)}…`;
}

function includeKeyword(text: string, keyword: string) {
  return text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())
    ? text
    : `${keyword}: ${text}`;
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseJsonResponse(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart < 0 || objectEnd <= objectStart) throw new Error("Ollama returned invalid metadata JSON");
    try {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as unknown;
    } catch (error) {
      throw new Error("Ollama returned invalid metadata JSON", { cause: error });
    }
  }
}

function getKeywordContext(transcript: string, keyword: string) {
  const sentences = sentenceParts(transcript);
  return sentences.find((sentence) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(keyword)}([^\\p{L}\\p{N}]|$)`, "iu").test(sentence)) ??
    sentences[0] ?? keyword;
}

function collectTags(keywords: string[]) {
  const tags = [...keywords];
  for (let left = 0; left < keywords.length && tags.length < 15; left += 1) {
    for (let right = left + 1; right < keywords.length && tags.length < 15; right += 1) {
      const combined = `${keywords[left]} ${keywords[right]}`;
      if (combined.length <= 30) tags.push(combined);
    }
  }
  for (const suffix of ["ideas", "explained", "guide", "topic", "clip", "video", "story", "tips", "talk", "shorts"]) {
    if (tags.length >= 10) break;
    for (const keyword of keywords) {
      const tag = `${keyword} ${suffix}`;
      if (tag.length <= 30) tags.push(tag);
      if (tags.length >= 10) break;
    }
  }
  const distinct = [...new Set(tags)];
  while (distinct.length < 10 && keywords.length > 0) {
    const suffix = ["insight", "learning", "discussion", "moments", "creator"][distinct.length - keywords.length];
    if (!suffix) break;
    const tag = `${keywords[0]} ${suffix}`;
    if (tag.length <= 30) distinct.push(tag);
  }
  return distinct.slice(0, 15);
}

function detectOutputScript(text: string) {
  const hindi = (text.match(/\p{Script=Devanagari}/gu) ?? []).length;
  const telugu = (text.match(/\p{Script=Telugu}/gu) ?? []).length;
  if (hindi > telugu && hindi > 0) return "hindi";
  if (telugu > 0) return "telugu";
  return "english";
}

function offlineHashtags(keywords: string[]) {
  const safe = keywords.filter((keyword) => keyword.length > 1).slice(0, 5);
  while (safe.length < 3 && keywords.length > 0) safe.push(keywords[safe.length % keywords.length]!);
  return [...new Set(safe)].slice(0, 5).map((word) => `#${word.replace(/[^\p{L}\p{M}\p{N}_]/gu, "")}`);
}

export function generateOfflineMetadata(
  input: ClipMetadataInput,
  options: MetadataOptions
): ClipMetadataResult {
  const transcript = cleanTranscript(input.transcript);
  const keywords = extractSignificantKeywords(transcript, 15);
  const selectedKeywords = keywords.slice(0, 5);
  const hashtagKeywords = [...new Set(extractSignificantKeywords(
    `${transcript} ${input.videoTitle} ${input.videoType}`, 20
  ))].slice(0, 5);
  const primaryKeyword = selectedKeywords[0] ?? transcript.split(/\s+/)[0] ?? "video";
  const phrases = selectedKeywords.map((keyword) =>
    truncate(includeKeyword(truncate(getKeywordContext(transcript, keyword), 56), keyword), 70)
  );
  while (phrases.length < 3) phrases.push(phrases[phrases.length - 1] ?? truncate(transcript, 70));

  const englishMode = options.language === "english";
  const transcriptTitles = selectedKeywords.slice(0, 3).map((keyword, index) => {
    const phrase = phrases[index]!;
    const keywordPosition = phrase.toLocaleLowerCase().indexOf(keyword.toLocaleLowerCase());
    return truncate(keywordPosition >= 0 && keywordPosition < 20 ? phrase : `${keyword}: ${phrase}`, 70);
  });
  while (transcriptTitles.length < 3) transcriptTitles.push(transcriptTitles.at(-1) ?? truncate(transcript, 70));
  const titleVariants = englishMode
    ? [
        `${primaryKeyword}: a closer look`,
        `${primaryKeyword}: key ideas`,
        `${primaryKeyword}: explained`
      ].map((title) => truncate(title, 70))
    : transcriptTitles.slice(0, 3);
  const hashtags = offlineHashtags(hashtagKeywords.length >= 3
    ? hashtagKeywords
    : [...hashtagKeywords, ...["clip", "video", input.videoType].filter((term) => !hashtagKeywords.includes(term))]);
  const excerpt = truncate(transcript, 220);
  const script = detectOutputScript(transcript);
  const callToAction = englishMode || script === "english"
    ? "Follow for more."
    : script === "hindi"
      ? "ऐसे और विचारों के लिए फ़ॉलो करें।"
      : "మరిన్ని విషయాల కోసం ఫాలో అవ్వండి.";
  const keyIdeas = selectedKeywords.join(", ");
  const summary = englishMode
    ? `This clip discusses ${keyIdeas || primaryKeyword}. It stays focused on ${keyIdeas || primaryKeyword}.`
    : includeKeyword(`${excerpt} ${phrases.find((phrase) => phrase !== excerpt) ?? excerpt}`, primaryKeyword);
  const description = [
    englishMode ? `Explore ${primaryKeyword} in this clip.` : phrases[0],
    englishMode ? `A closer look at ${keyIdeas || primaryKeyword}.` : phrases[1] ?? phrases[0],
    "",
    summary,
    "",
    callToAction,
    "",
    hashtags.join(" ")
  ].join("\n");
  const reelsCaption = `${englishMode ? `A closer look at ${primaryKeyword}.` : includeKeyword(excerpt, primaryKeyword)}\n\n${hashtags.join(" ")}`;
  const tiktokCaption = `${englishMode ? `${primaryKeyword}: key ideas.` : includeKeyword(truncate(excerpt, 160), primaryKeyword)}\n${hashtags.slice(0, 4).join(" ")}`;

  return clipMetadataResultSchema.parse({
    youtube: {
      titleVariants,
      selectedTitleIndex: 0,
      description,
      tags: collectTags(keywords.length > 0 ? keywords : [primaryKeyword]),
      hashtags
    },
    instagramReels: { caption: truncate(reelsCaption, 2_200) },
    tiktok: { caption: truncate(tiktokCaption, 2_200) }
  });
}

function fieldIssues(
  base: ClipMetadataResult,
  field: string,
  value: string | string[] | { tags: string[]; hashtags: string[] } |
    ClipMetadataResult["instagramReels"] | ClipMetadataResult["tiktok"],
  input: ClipMetadataInput,
  creditLine?: string
) {
  const updated = structuredClone(base);
  if (field.startsWith("youtube.titleVariants.")) {
    const index = Number(field.split(".").at(-1));
    updated.youtube.titleVariants[index] = value as string;
  } else if (field === "youtube.description") {
    updated.youtube.description = value as string;
  } else if (field === "youtube.tags") {
    updated.youtube.tags = value as string[];
  } else if (field === "youtube.hashtags") {
    if (Array.isArray(value)) {
      updated.youtube.hashtags = value;
    } else {
      const tags = value as { tags: string[]; hashtags: string[] };
      updated.youtube.tags = tags.tags;
      updated.youtube.hashtags = tags.hashtags;
    }
    updated.youtube.description = `${updated.youtube.description.replace(/#[\p{L}\p{M}\p{N}_]+/gu, "").trim()}\n\n${updated.youtube.hashtags.join(" ")}`;
  } else if (field === "instagramReels.caption") {
    updated.instagramReels = { caption: value as string };
  } else if (field === "tiktok.caption") {
    updated.tiktok = { caption: value as string };
  }
  const checked = validateMetadataRules(appendCredit(updated, creditLine), input.transcript, {
    sourceTitle: input.videoTitle,
    videoType: input.videoType,
    ...(creditLine ? { creditLine } : {})
  });
  const issues = checked.success ? [] : checked.issues.filter((issue) =>
    issue.field === field || (field === "youtube.hashtags" && issue.field === "youtube.description")
  );
  if (field.startsWith("youtube.titleVariants.") && typeof value === "string" && input.trendSignals?.samples.length) {
    const overlap = titleWordOverlap(value, input.trendSignals.samples.map((sample) => sample.title));
    if (overlap > 0) issues.push({
      field,
      message: `Title overlaps fetched competitor titles by ${(overlap * 100).toFixed(0)}%; make it more original`
    });
  }
  return issues;
}

function warningsByField(issues: Array<{ field: string; message: string }>) {
  const grouped: Record<string, string[]> = {};
  for (const { field, message } of issues) (grouped[field] ??= []).push(message);
  return grouped;
}

function safeProviderError(error: unknown) {
  let message = error instanceof Error ? error.message : "Provider failed";
  const key = process.env.GEMINI_API_KEY?.trim();
  if (key) message = message.replaceAll(key, "[redacted]");
  return message.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]");
}

function fallbackSummary(reasons: string[]) {
  return [...new Set(reasons)].join("; ").slice(0, 1000);
}

function parsePart<T>(raw: string, schema: { safeParse(value: unknown): { success: boolean; data?: T; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, part: string): T {
  const parsed = schema.safeParse(parseJsonResponse(raw));
  if (!parsed.success || parsed.data === undefined) {
    const detail = parsed.error?.issues.map((issue) =>
      `${issue.path.join(".") || part}: ${issue.message}`
    ).join("; ");
    throw new Error(`${part} response was invalid${detail ? `: ${detail}` : ""}`);
  }
  return parsed.data;
}

async function requestPart(
  provider: MetadataProvider,
  input: ClipMetadataInput,
  options: MetadataOptions,
  part: ClipMetadataPart,
  feedback?: string,
  signal?: AbortSignal
) {
  const prompt: ClipMetadataPromptInput = {
    transcript: input.transcript,
    videoTitle: input.videoTitle,
    videoType: input.videoType,
    language: options.language,
    tone: options.tone,
    ...(input.trendSignals ? { trendSignals: input.trendSignals } : {}),
    ...(input.nicheQueries ? { nicheQueries: input.nicheQueries } : {}),
    ...(feedback ? { validationFeedback: feedback } : {}),
    ...(signal ? { signal } : {})
  };
  return provider.generateMetadataPartJson(prompt, part);
}

async function generateForProvider(
  provider: MetadataProvider,
  input: ClipMetadataInput,
  options: MetadataOptions,
  signal: AbortSignal
) {
  const creditLine = createCreditLine(input);
  const result = generateOfflineMetadata(input, options);
  const offlineBaseline = structuredClone(result);
  const partialFallbacks: Record<string, string[]> = {};
  const recordPartialFallback = (field: string, error: unknown) => {
    const message = safeProviderError(error);
    if (!/(unsupported health|numbers not present|name not present|quote that does not|ALL-CAPS|guarantee|fake urgency|viral claim|tags exceed|hashtags)/i.test(message)) {
      throw error;
    }
    partialFallbacks[field] = [`Hard-blocked AI wording; used Offline for this field: ${message}`];
  };
  const validationContext = {
    sourceTitle: input.videoTitle,
    videoType: input.videoType,
    ...(creditLine ? { creditLine } : {})
  };
  type FieldValue = string | string[] | { tags: string[]; hashtags: string[] };
  const generateField = async <T>(
    field: string,
    part: ClipMetadataPart,
    schema: { safeParse(value: unknown): { success: boolean; data?: T; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } },
    extractValue: (parsed: T) => FieldValue,
    initialFeedback?: string
  ): Promise<T> => {
    let feedback = initialFeedback;
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = await requestPart(provider, input, options, part, feedback, signal);
      let parsed: T;
      try {
        parsed = parsePart(raw, schema, field);
      } catch (error) {
        lastError = error instanceof Error ? error.message : "The field was invalid";
        feedback = `Return valid JSON for only ${field}. ${lastError}`;
        continue;
      }
      const issues = fieldIssues(result, field, extractValue(parsed), input, creditLine);
      if (issues.length === 0) return parsed;
      feedback = issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
      lastError = feedback;
    }
    throw new Error(`${provider.providerName} could not produce a safe ${field} after two retries${lastError ? `: ${lastError}` : ""}`);
  };

  const titles = await generateField(
    "youtube.titleVariants",
    "titles",
    clipMetadataTitlesSchema,
    (parsed) => parsed.titleVariants
  );
  result.youtube.titleVariants = titles.titleVariants;
  result.youtube.selectedTitleIndex = titles.selectedTitleIndex;
  for (const [index, title] of result.youtube.titleVariants.entries()) {
    const titleField = `youtube.titleVariants.${index}`;
    const issues = fieldIssues(result, titleField, title, input, creditLine);
    if (issues.length === 0) continue;
    try {
      const corrected = await generateField(
        titleField,
        "title",
        clipMetadataTitleSchema,
        (parsed) => parsed.title,
        issues.map((issue) => issue.message).join("; ")
      );
      result.youtube.titleVariants[index] = corrected.title;
    } catch (error) {
      recordPartialFallback(titleField, error);
      result.youtube.titleVariants[index] = offlineBaseline.youtube.titleVariants[index]!;
    }
  }

  try {
    const description = await generateField(
      "youtube.description",
      "description",
      clipMetadataDescriptionSchema,
      (parsed) => parsed.description
    );
    result.youtube.description = description.description;
  } catch (error) {
    recordPartialFallback("youtube.description", error);
    result.youtube.description = offlineBaseline.youtube.description;
  }
  try {
    const hashtags = await generateField(
      "youtube.hashtags",
      "hashtags",
      clipMetadataHashtagsSchema,
      (parsed) => ({ tags: parsed.tags, hashtags: parsed.hashtags })
    );
    result.youtube.tags = hashtags.tags;
    result.youtube.hashtags = hashtags.hashtags;
  } catch (error) {
    recordPartialFallback("youtube.hashtags", error);
    result.youtube.tags = offlineBaseline.youtube.tags;
    result.youtube.hashtags = offlineBaseline.youtube.hashtags;
  }
  const descriptionBody = result.youtube.description
    .split(/\r?\n/)
    .filter((line) => !/^\s*#[\p{L}\p{M}\p{N}_]+(?:\s+#[\p{L}\p{M}\p{N}_]+)*\s*$/u.test(line))
    .join("\n")
    .trim();
  result.youtube.description = `${descriptionBody}\n\n${result.youtube.hashtags.join(" ")}`;

  try {
    const captions = await generateField(
      "platformCaptions",
      "platformCaptions",
      clipMetadataPlatformCaptionsSchema,
      (parsed) => `${parsed.instagramReels.caption}\n${parsed.tiktok.caption}`
    );
    result.instagramReels = captions.instagramReels;
    result.tiktok = captions.tiktok;
  } catch (error) {
    recordPartialFallback("platformCaptions", error);
    result.instagramReels = offlineBaseline.instagramReels;
    result.tiktok = offlineBaseline.tiktok;
  }
  for (const field of ["instagramReels.caption", "tiktok.caption"] as const) {
    let caption = field === "instagramReels.caption" ? result.instagramReels.caption : result.tiktok.caption;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const issues = fieldIssues(result, field, caption, input, creditLine);
      if (issues.length === 0) break;
      if (attempt === 2) {
        const error = new Error(`${provider.providerName} could not produce a safe ${field} after two retries: ${issues.map((issue) => issue.message).join("; ")}`);
        recordPartialFallback(field, error);
        caption = field === "instagramReels.caption"
          ? offlineBaseline.instagramReels.caption
          : offlineBaseline.tiktok.caption;
        break;
      }
      const regenerated = parsePart(
        await requestPart(provider, input, options, "platformCaptions", issues.map((issue) => issue.message).join("; "), signal),
        clipMetadataPlatformCaptionsSchema,
        field
      );
      caption = field === "instagramReels.caption"
        ? regenerated.instagramReels.caption
        : regenerated.tiktok.caption;
    }
    if (field === "instagramReels.caption") result.instagramReels.caption = caption;
    else result.tiktok.caption = caption;
  }

  const completed = appendCredit(result, creditLine);
  const checked = validateMetadataRules(completed, input.transcript, validationContext);
  if (!checked.success) throw new Error(`${provider.providerName} produced unsafe metadata: ${checked.errors.join("; ")}`);
  return {
    result: checked.data,
    warnings: { ...warningsByField(checked.warnings), ...partialFallbacks },
    partialFallback: Object.keys(partialFallbacks).length > 0
  };
}

export async function generateMetadataWithFallback(
  input: ClipMetadataInput,
  options: MetadataOptions,
  providers: MetadataProvider[],
  cache: ClipMetadataCache,
  unavailableReasons: string[] = [],
  providerOrder: Array<"gemini" | "ollama" | "offline"> = ["gemini", "ollama", "offline"]
): Promise<ClipMetadataGeneration> {
  const modelIdentifier = `${providerOrder.map((name) => {
    const provider = providers.find((candidate) => candidate.providerName.toLocaleLowerCase() === name);
    return provider ? `${provider.providerName}:${provider.modelName}` : name;
  }).join(",")}:${input.useGemini ? "gemini-opt-in" : "no-gemini-consent"}`;
  const contentHash = clipMetadataContentHash(input, modelIdentifier);
  const cached = await cache.get(contentHash);
  if (cached) {
    return {
      contentHash,
      ...cached,
      provider: cached.provider ?? (cached.mode === "Offline" ? "Offline" : "Ollama"),
      warnings: cached.warnings ?? {},
      cached: true
    };
  }

  const failures = [...unavailableReasons];
  const providerDeadlineMs = process.env.METADATA_PROVIDER_TIMEOUT_MS
    ? Number(process.env.METADATA_PROVIDER_TIMEOUT_MS)
    : 15_000;
  const providerDeadline = AbortSignal.timeout(
    Number.isFinite(providerDeadlineMs) && providerDeadlineMs > 0 ? providerDeadlineMs : 15_000
  );
  const providerByName = new Map(providers.map((provider) => [provider.providerName.toLocaleLowerCase(), provider]));
  const makeOffline = async () => {
    const creditLine = createCreditLine(input);
    const offline = appendCredit(generateOfflineMetadata(input, options), creditLine);
    const checked = validateMetadataRules(offline, input.transcript, {
      sourceTitle: input.videoTitle,
      videoType: input.videoType,
      ...(creditLine ? { creditLine } : {})
    });
    if (!checked.success) throw new Error(`Offline metadata failed content rules: ${checked.errors.join("; ")}`);
    const value = {
      result: checked.data,
      mode: "Offline" as const,
      provider: "Offline" as const,
      ...(failures.length > 0 ? { fallbackReason: fallbackSummary(failures) } : {}),
      warnings: warningsByField(checked.warnings)
    };
    await cache.set(contentHash, value);
    return { contentHash, ...value, cached: false };
  };

  // Persist the safe Offline result first. The UI can use it immediately while
  // an opted-in remote/local provider is still running, instead of appearing idle.
  await makeOffline();

  for (const name of providerOrder) {
    if (name === "offline") return makeOffline();
    if (name === "gemini") {
      if (!input.useGemini) continue;
      if (!process.env.GEMINI_API_KEY?.trim()) {
        failures.push("Gemini was skipped because GEMINI_API_KEY is not configured");
        continue;
      }
    }
    const provider = providerByName.get(name);
    if (!provider) continue;
    try {
      const generated = await generateForProvider(provider, input, options, providerDeadline);
      const resultProvider = generated.partialFallback
        ? `${provider.providerName} + Offline` as const
        : provider.providerName;
      const value = {
        result: generated.result,
        mode: "AI" as const,
        provider: resultProvider,
        ...(failures.length > 0 ? { fallbackReason: fallbackSummary(failures) } : {}),
        ...(generated.partialFallback
          ? { fallbackReason: fallbackSummary([...failures, `${provider.providerName} validation rejected one or more fields; those fields use Offline templates`]) }
          : {}),
        warnings: generated.warnings
      };
      await cache.set(contentHash, value);
      return { contentHash, ...value, cached: false };
    } catch (error) {
      const reason = safeProviderError(error);
      failures.push(`${provider.providerName}: ${reason}`);
      console.warn(JSON.stringify({
        level: "warn",
        event: "clip.metadata.provider_fallback",
        contentHash,
        provider: provider.providerName,
        reason: `${provider.providerName} could not generate safe metadata`,
        error: reason
      }));
    }
  }

  return makeOffline();
}
