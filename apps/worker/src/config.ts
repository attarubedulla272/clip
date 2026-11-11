import "dotenv/config";

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

const modelSize = process.env.WHISPER_MODEL_SIZE ?? "base";
if (!["tiny", "base", "small", "medium", "large-v3"].includes(modelSize)) {
  throw new Error("WHISPER_MODEL_SIZE must be tiny, base, small, medium, or large-v3");
}

export type LlmProviderName = "gemini" | "ollama" | "offline";
export function parseLlmProviderOrder(value = "gemini,ollama,offline"): LlmProviderName[] {
  const order = value.split(",").map((provider) => provider.trim().toLocaleLowerCase()).filter(Boolean);
  if (order.length === 0 || order.some((provider) => !["gemini", "ollama", "offline"].includes(provider))) {
    throw new Error("LLM_PROVIDER_ORDER must contain gemini, ollama, and/or offline");
  }
  if (new Set(order).size !== order.length) throw new Error("LLM_PROVIDER_ORDER must not repeat providers");
  return order as LlmProviderName[];
}

export const config = {
  mongoUri: process.env.MONGO_URI ?? "mongodb://localhost:27017/clipforge",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  whisperModelSize: modelSize,
  whisperChunkSeconds: positiveInteger(process.env.WHISPER_CHUNK_SECONDS, 30, "WHISPER_CHUNK_SECONDS"),
  maxVideoDurationSeconds: positiveInteger(process.env.MAX_VIDEO_DURATION_SECONDS, 3600, "MAX_VIDEO_DURATION_SECONDS"),
  llmProviderOrder: parseLlmProviderOrder(process.env.LLM_PROVIDER_ORDER),
  metadataProviderTimeoutMs: positiveInteger(process.env.METADATA_PROVIDER_TIMEOUT_MS, 15_000, "METADATA_PROVIDER_TIMEOUT_MS"),
  metadataOllamaProbeTimeoutMs: positiveInteger(process.env.METADATA_OLLAMA_PROBE_TIMEOUT_MS, 800, "METADATA_OLLAMA_PROBE_TIMEOUT_MS"),
  trendNetworkTimeoutMs: positiveInteger(process.env.TREND_NETWORK_TIMEOUT_MS, 5_000, "TREND_NETWORK_TIMEOUT_MS"),
  youtubeApiKey: process.env.YOUTUBE_API_KEY?.trim() || "",
  youtubeRegionCode: (process.env.YOUTUBE_REGION_CODE ?? "IN").trim().toUpperCase().slice(0, 2),
  youtubeRelevanceLanguage: (process.env.YOUTUBE_RELEVANCE_LANGUAGE ?? "en").trim().slice(0, 10),
  youtubeDailyBudget: positiveInteger(process.env.YOUTUBE_DAILY_QUOTA_BUDGET, 10000, "YOUTUBE_DAILY_QUOTA_BUDGET"),
  youtubeSafetyStopFraction: (() => {
    const value = Number(process.env.YOUTUBE_QUOTA_SAFETY_STOP_FRACTION ?? "0.8");
    return Number.isFinite(value) && value > 0 && value < 1 ? value : 0.8;
  })(),
  youtubeSearchListCost: nonNegativeInteger(process.env.YOUTUBE_SEARCH_LIST_COST, 100, "YOUTUBE_SEARCH_LIST_COST"),
  youtubeVideosListCost: nonNegativeInteger(process.env.YOUTUBE_VIDEOS_LIST_COST, 1, "YOUTUBE_VIDEOS_LIST_COST")
} as const;
