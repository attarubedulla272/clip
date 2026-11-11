import type { ClipScoreInput } from "@clipforge/shared/clip-scoring";
import { clipStandaloneAssessmentSchema } from "@clipforge/shared/clip-standalone";
import {
  clipMetadataDescriptionSchema,
  clipMetadataHashtagsSchema,
  clipMetadataPlatformCaptionsSchema,
  clipMetadataResultSchema,
  clipMetadataTitleSchema,
  clipMetadataTitlesSchema,
  extractSignificantKeywords
} from "@clipforge/shared/clip-metadata";
import type {
  ClipMetadataPart,
  ClipMetadataPromptInput,
  LlmProvider
} from "./llm-provider.js";

interface OllamaGenerateResponse {
  response?: unknown;
  error?: unknown;
}

export class OllamaProvider implements LlmProvider {
  readonly providerName = "Ollama" as const;
  readonly modelName: string;
  private readonly endpoint: string;

  constructor(
    baseUrl = process.env.OLLAMA_BASE_URL ?? "http://host.docker.internal:11434",
    modelName = process.env.OLLAMA_MODEL ?? "llama3.2:3b",
    private readonly request: typeof fetch = fetch
  ) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch (error) {
      throw new Error("OLLAMA_BASE_URL must be a valid URL", { cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("OLLAMA_BASE_URL must use HTTP or HTTPS");
    }
    this.endpoint = `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/generate`;
    this.modelName = modelName;
  }

  async generateScoreJson(input: ClipScoreInput): Promise<string> {
    const transcript = input.transcriptText.trim().split(/\s+/).slice(0, 300).join(" ");
    const prompt = [
      "Score this short video transcript as guidance, never as a prediction of virality.",
      "Return exactly this JSON shape, using integer scores 0-100 and one short, single-line reason per part:",
      '{"score":50,"breakdown":{"hookStrength":{"score":50,"reason":"..."},"emotionalPeak":{"score":50,"reason":"..."},"standaloneClarity":{"score":50,"reason":"..."},"pacing":{"score":50,"reason":"..."},"payoff":{"score":50,"reason":"..."}},"standaloneCheck":{"isStandalone":true,"reason":"..."}}',
      "Judge hook strength from the opening seconds, emotional peak from expressive language/signals, standalone clarity without missing context, pacing from speech and pauses, and payoff from how the thought resolves.",
      "Explicitly decide whether a viewer can understand this clip without the rest of the video. A short one-line reason is required.",
      "Do not invent visual events or claim guaranteed success.",
      `Duration: ${Math.round(input.durationSeconds)} seconds.`,
      `Topic: ${input.topicLabel}.`,
      `Signals: ${input.signalsFound.length > 0 ? input.signalsFound.join("; ") : "none detected"}.`,
      `Transcript (maximum 300 words): ${transcript}`
    ].join("\n");
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.modelName,
        prompt,
        stream: false,
        format: "json",
        keep_alive: "30s",
        options: {
          temperature: 0.1,
          num_ctx: 2048,
          num_predict: 500
        }
      }),
      signal: AbortSignal.timeout(120_000)
    });

    let payload: OllamaGenerateResponse;
    try {
      payload = await response.json() as OllamaGenerateResponse;
    } catch (error) {
      throw new Error("Ollama returned an unreadable response", { cause: error });
    }
    if (!response.ok) {
      const detail = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(`Ollama scoring request failed: ${detail}`);
    }
    if (typeof payload.response !== "string") {
      throw new Error("Ollama did not return JSON text for the clip score");
    }
    return payload.response;
  }

  async generateStandaloneJson(transcriptText: string) {
    const transcript = transcriptText.trim().split(/\s+/).slice(0, 180).join(" ");
    const prompt = [
      "Check if this short transcript clip stands alone for a viewer.",
      `Return only JSON matching this schema: ${JSON.stringify(clipStandaloneAssessmentSchema.toJSONSchema())}`,
      "Use only the transcript. Suggest small start/end adjustments in seconds; negative start means earlier, positive end means later. Use 0 when no adjustment is needed.",
      `Transcript: ${transcript}`
    ].join("\n");
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.modelName,
        prompt,
        stream: false,
        format: "json",
        keep_alive: "30s",
        options: { temperature: 0.1, num_ctx: 1024, num_predict: 220 }
      }),
      signal: AbortSignal.timeout(60_000)
    });
    let payload: OllamaGenerateResponse;
    try {
      payload = await response.json() as OllamaGenerateResponse;
    } catch (error) {
      throw new Error("Ollama returned an unreadable standalone-check response", { cause: error });
    }
    if (!response.ok) {
      const detail = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(`Ollama standalone-check request failed: ${detail}`);
    }
    if (typeof payload.response !== "string") {
      throw new Error("Ollama did not return JSON text for the standalone check");
    }
    return payload.response;
  }

  async generateMetadataJson(input: ClipMetadataPromptInput): Promise<string> {
    const transcript = input.transcript.trim().split(/\s+/).slice(0, 180).join(" ");
    const creditInstruction = input.originalCredit
      ? `Add this exact credit line at the end of the YouTube description: ${input.originalCredit}`
      : "Do not add an original-video credit line.";
    const feedbackInstruction = input.validationFeedback
      ? `Fix only these fields from the previous response, following each reason exactly. Keep the other fields unchanged: ${input.validationFeedback}`
      : "";
    const sourceSentences = (transcript.match(/[^.!?।]+[.!?।]?/gu) ?? [])
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .slice(0, 2);
    const exampleKeywords = extractSignificantKeywords(transcript, 3);
    const exampleHashtags = exampleKeywords.map((keyword) => `#${keyword.replace(/[^\p{L}\p{M}\p{N}_]/gu, "")}`);
    const exampleDescription = [
      sourceSentences[0] ?? transcript,
      sourceSentences[1] ?? sourceSentences[0] ?? transcript,
      "",
      sourceSentences[0] ?? transcript,
      sourceSentences[1] ?? sourceSentences[0] ?? transcript,
      "",
      "Follow for more.",
      "",
      exampleHashtags.join(" ")
    ].join("\n");
    const prompt = [
      "Create short metadata from this clip. Use only its transcript and title; never invent facts, topics, or claims.",
      `Output language: ${input.language === "english" ? "English, but preserve at least one significant transcript keyword verbatim in every title and description hook; for Hindi/Telugu, keep that keyword in its original script." : "the transcript's language; preserve mixed languages and transcript keywords verbatim"}.`,
      `Tone: ${input.tone}.`,
      "Return one JSON object only, matching the JSON schema exactly. No markdown.",
      '{"youtube":{"titleVariants":["...","...","..."],"selectedTitleIndex":0,"description":"...","tags":["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10"],"hashtags":["#tag1","#tag2","#tag3"]},"instagramReels":{"caption":"hook line then #tag1 #tag2 #tag3"},"tiktok":{"caption":"short hook then #tag1 #tag2 #tag3"}}',
      `Description example using source text: ${exampleDescription}`,
      "Description must use that exact line layout, with two hook lines, two short transcript-based summary lines, a CTA, and exactly three hashtags. Repeat those hashtags in the hashtags array.",
      "Titles: exactly 3, <=70 characters, each includes a significant transcript keyword. Tags: 10-15, each made only from transcript keywords or phrases; total <=500 characters. Reel and TikTok captions: 3-5 hashtags.",
      "Copy the source's claims instead of paraphrasing them. Do not say boost, improve, increase, reduce, cure, or prevent unless that exact claim word appears in the transcript. No guarantees, unsupported claims, all-caps, fake urgency, or virality language.",
      feedbackInstruction,
      creditInstruction,
      `Video title: ${input.videoTitle.slice(0, 160)}`,
      `Detected video type: ${input.videoType}`,
      `Transcript: ${transcript}`
    ].join("\n");
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.modelName,
        prompt,
        stream: false,
        format: clipMetadataResultSchema.toJSONSchema(),
        keep_alive: "30s",
        options: { temperature: 0.1, num_ctx: 1536, num_predict: 650 }
      }),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000)
    });

    let payload: OllamaGenerateResponse;
    try {
      payload = await response.json() as OllamaGenerateResponse;
    } catch (error) {
      throw new Error("Ollama returned an unreadable metadata response", { cause: error });
    }
    if (!response.ok) {
      const detail = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(`Ollama metadata request failed: ${detail}`);
    }
    if (typeof payload.response !== "string") throw new Error("Ollama did not return JSON text for metadata");
    return payload.response;
  }

  async generateMetadataPartJson(input: ClipMetadataPromptInput, part: ClipMetadataPart): Promise<string> {
    const transcript = input.transcript.trim().split(/\s+/).slice(0, part === "description" ? 120 : 160).join(" ");
    const keywords = extractSignificantKeywords(transcript, 8);
    const descriptionExample = [
      "Hook line using a transcript keyword.",
      "A second short transcript-based hook.",
      "",
      "A concise summary sentence.",
      "A second summary sentence grounded in the transcript.",
      "",
      "Follow for more."
    ].join("\n");
    const schema = {
      titles: clipMetadataTitlesSchema,
      title: clipMetadataTitleSchema,
      description: clipMetadataDescriptionSchema,
      hashtags: clipMetadataHashtagsSchema,
      platformCaptions: clipMetadataPlatformCaptionsSchema
    }[part];
    const instructions = {
      titles: [
        `Use these significant transcript keywords verbatim: ${keywords.join(", ")}.`,
        "Return exactly 3 titles, each <=70 characters and containing one of those keywords. Set selectedTitleIndex to 0."
      ],
      title: [
        "Return one corrected title only. Keep it <=70 characters, include a significant transcript keyword, and fix only the stated validation problem."
      ],
      description: [
        `Use this source-based example layout with literal newlines: ${descriptionExample}`,
        `Use these transcript keywords in the two hook lines: ${keywords.slice(0, 5).join(", ")}.`,
        "Write two short summary lines copied from the transcript and a CTA. Hashtags are generated separately."
      ],
      hashtags: [
        `Return 10-15 short tags from transcript terms and exactly 3 hashtags using these words: ${keywords.slice(0, 5).join(", ")}.`
      ],
      platformCaptions: [
        `Write one short caption per platform. Use 3 hashtags in each, copied from transcript terms.`,
        "Do not add research claims, advice, health effects, numbers, or names unless stated in the transcript. Use a short source phrase, not a new factual paraphrase.",
        input.validationFeedback ?? ""
      ]
    }[part];
    const languageInstruction = input.language === "english"
      ? "Write in English. Preserve source keywords as needed."
      : "Follow the transcript's actual text and mixed-language style. Do not infer language from external metadata.";
    const prompt = [
      `Generate only the ${part} fields for this clip.`,
      languageInstruction,
      `Tone: ${input.tone}.`,
      ...instructions,
      "Use only facts and topics present in the transcript or source title. Copy claims instead of paraphrasing them. Do not say boost, improve, increase, reduce, cure, or prevent unless that exact claim word appears in the transcript. Never use a guarantee, fake urgency, ALL-CAPS, or virality claim.",
      input.trendSignals ? `Trend guidance only: queries=${input.trendSignals.queries.join("; ")}; keywords=${input.trendSignals.topKeywords.join(", ")}; hashtags=${input.trendSignals.commonHashtags.join(", ")}. Do not copy sample titles.` : "",
      input.validationFeedback && part !== "platformCaptions" ? `Fix this field-specific validation feedback: ${input.validationFeedback}` : "",
      `Video title: ${input.videoTitle.slice(0, 120)}`,
      `Transcript: ${transcript}`
    ].filter(Boolean).join("\n");
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.modelName,
        prompt,
        stream: false,
        format: schema.toJSONSchema(),
        keep_alive: "30s",
        options: {
          temperature: 0.1,
          num_ctx: 1024,
          num_predict: part === "titles" ? 180 : part === "hashtags" ? 160 : part === "description" ? 240 : 220
        }
      }),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000)
    });

    let payload: OllamaGenerateResponse;
    try {
      payload = await response.json() as OllamaGenerateResponse;
    } catch (error) {
      throw new Error("Ollama returned an unreadable metadata response", { cause: error });
    }
    if (!response.ok) {
      const detail = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(`Ollama metadata request failed: ${detail}`);
    }
    if (typeof payload.response !== "string") throw new Error("Ollama did not return JSON text for metadata");
    return payload.response;
  }
}
