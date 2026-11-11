import type { ClipScoreInput } from "@clipforge/shared/clip-scoring";
import type {
  clipMetadataDescriptionSchema,
  clipMetadataHashtagsSchema,
  clipMetadataPlatformCaptionsSchema,
  clipMetadataTitleSchema,
  clipMetadataTitlesSchema
} from "@clipforge/shared/clip-metadata";

export interface ClipMetadataPromptInput {
  transcript: string;
  videoTitle: string;
  videoType: string;
  language: "same" | "english";
  tone: "curious" | "direct" | "informative";
  originalCredit?: string;
  validationFeedback?: string;
  signal?: AbortSignal;
  trendSignals?: import("@clipforge/shared/clip-metadata").TrendSignals;
  nicheQueries?: string[];
}

export type ClipMetadataPart =
  | "titles"
  | "title"
  | "description"
  | "hashtags"
  | "platformCaptions";

export type ClipMetadataPartSchema =
  | typeof clipMetadataDescriptionSchema
  | typeof clipMetadataHashtagsSchema
  | typeof clipMetadataPlatformCaptionsSchema
  | typeof clipMetadataTitleSchema
  | typeof clipMetadataTitlesSchema;

export interface LlmProvider {
  readonly providerName?: "Gemini" | "Ollama";
  readonly modelName: string;
  generateScoreJson(input: ClipScoreInput): Promise<string>;
  generateStandaloneJson?(transcript: string): Promise<string>;
  generateMetadataPartJson?(
    input: ClipMetadataPromptInput,
    part: ClipMetadataPart
  ): Promise<string>;
}
