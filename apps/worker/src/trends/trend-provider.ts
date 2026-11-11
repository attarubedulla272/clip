import {
  deriveTrendQueries,
  extractSignificantKeywords,
  TREND_CONFIG,
  type TrendSignals
} from "@clipforge/shared/clip-metadata";
import { config } from "../config.js";
import { WorkerTrendCacheModel, WorkerTrendQuotaModel } from "../models.js";

export interface TrendProvider {
  fetch(input: { clipText: string; topicLabel: string; videoType: string; language: string }): Promise<TrendSignals>;
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function countKeywords(samples: Array<{ title: string; tags: string[] }>) {
  const text = samples.flatMap((sample) => [sample.title, ...sample.tags]).join(" ");
  return extractSignificantKeywords(text, 20);
}

function commonHashtags(samples: Array<{ tags: string[] }>) {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    for (const tag of sample.tags) {
      const cleaned = `#${tag.trim().replace(/[^\p{L}\p{M}\p{N}_]/gu, "").slice(0, 50)}`;
      if (cleaned.length > 1) counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([tag]) => tag);
}

export class YouTubeTrendProvider implements TrendProvider {
  private readonly safetyStop = Math.floor(config.youtubeDailyBudget * config.youtubeSafetyStopFraction);

  async fetch(input: { clipText: string; topicLabel: string; videoType: string; language: string }): Promise<TrendSignals> {
    const regionCode = config.youtubeRegionCode || TREND_CONFIG.defaultRegionCode;
    const relevanceLanguage = input.language === "en" || input.language.startsWith("en")
      ? "en"
      : input.language.slice(0, 10);
    const queries = deriveTrendQueries(input.clipText, input.topicLabel, input.videoType);
    const cacheKey = JSON.stringify({ queries, regionCode, relevanceLanguage });
    const cached = await WorkerTrendCacheModel.findOne({ cacheKey, expiresAt: { $gt: new Date() } }).lean();
    if (cached?.signals) return cached.signals as TrendSignals;

    if (!config.youtubeApiKey) return this.offline(queries, regionCode, relevanceLanguage, "YOUTUBE_API_KEY is not configured");

    const day = utcDay();
    const quota = await WorkerTrendQuotaModel.findOneAndUpdate(
      { day },
      { $setOnInsert: { day, unitsUsed: 0, safetyStopUnits: this.safetyStop } },
      { upsert: true, new: true }
    );
    const used = quota.unitsUsed ?? 0;
    if (used >= this.safetyStop) {
      return this.offline(queries, regionCode, relevanceLanguage, "YouTube quota safety stop reached", used);
    }

    const samples: TrendSignals["samples"] = [];
    try {
      for (const query of queries.slice(0, 2)) {
        if ((quota.unitsUsed ?? 0) + config.youtubeSearchListCost > this.safetyStop) break;
        const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
        searchUrl.searchParams.set("key", config.youtubeApiKey);
        searchUrl.searchParams.set("part", "id");
        searchUrl.searchParams.set("type", "video");
        searchUrl.searchParams.set("order", "relevance");
        searchUrl.searchParams.set("maxResults", "8");
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("regionCode", regionCode);
        searchUrl.searchParams.set("relevanceLanguage", relevanceLanguage);
        searchUrl.searchParams.set("publishedAfter", new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString());
        const searchResponse = await fetch(searchUrl, { signal: AbortSignal.timeout(config.trendNetworkTimeoutMs) });
        if (!searchResponse.ok) throw new Error(`YouTube search failed (HTTP ${searchResponse.status})`);
        await WorkerTrendQuotaModel.updateOne({ day }, { $inc: { unitsUsed: config.youtubeSearchListCost } });
        quota.unitsUsed = (quota.unitsUsed ?? 0) + config.youtubeSearchListCost;
        const searchPayload = await searchResponse.json() as { items?: Array<{ id?: { videoId?: string } }> };
        const ids = (searchPayload.items ?? []).map((item) => item.id?.videoId).filter((id): id is string => Boolean(id)).slice(0, 8);
        if (ids.length === 0) continue;
        if ((quota.unitsUsed ?? 0) + config.youtubeVideosListCost > this.safetyStop) break;
        const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
        videosUrl.searchParams.set("key", config.youtubeApiKey);
        videosUrl.searchParams.set("part", "snippet,statistics");
        videosUrl.searchParams.set("id", ids.join(","));
        const videosResponse = await fetch(videosUrl, { signal: AbortSignal.timeout(config.trendNetworkTimeoutMs) });
        if (!videosResponse.ok) throw new Error(`YouTube videos failed (HTTP ${videosResponse.status})`);
        await WorkerTrendQuotaModel.updateOne({ day }, { $inc: { unitsUsed: config.youtubeVideosListCost } });
        quota.unitsUsed = (quota.unitsUsed ?? 0) + config.youtubeVideosListCost;
        const videosPayload = await videosResponse.json() as {
          items?: Array<{ id: string; snippet?: { title?: string; tags?: string[]; publishedAt?: string }; statistics?: { viewCount?: string } }>
        };
        for (const item of videosPayload.items ?? []) {
          if (!item.snippet?.title) continue;
          const id = item.id;
          samples.push({
            title: item.snippet.title,
            url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
            videoId: id,
            tags: item.snippet.tags ?? [],
            viewCount: Number.parseInt(item.statistics?.viewCount ?? "0", 10) || 0,
            ...(item.snippet.publishedAt ? { publishedAt: item.snippet.publishedAt } : {})
          });
        }
        if (samples.length >= 8) break;
      }
      const unique = [...new Map(samples.map((sample) => [sample.videoId, sample])).values()].slice(0, 8);
      const signals: TrendSignals = {
        mode: "online",
        badge: "Trend data: online",
        queries,
        samples: unique,
        topKeywords: countKeywords(unique),
        commonHashtags: commonHashtags(unique),
        fetchedAt: new Date().toISOString(),
        regionCode,
        relevanceLanguage,
        quotaUsedToday: quota.unitsUsed ?? 0,
        quotaRemaining: Math.max(0, this.safetyStop - (quota.unitsUsed ?? 0))
      };
      await WorkerTrendCacheModel.findOneAndUpdate(
        { cacheKey },
        { $set: { cacheKey, signals, expiresAt: new Date(Date.now() + TREND_CONFIG.cacheTtlHours * 60 * 60 * 1000) } },
        { upsert: true, new: true }
      );
      return signals;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "YouTube trend request failed";
      return this.offline(queries, regionCode, relevanceLanguage, reason, quota.unitsUsed ?? 0);
    }
  }

  private offline(
    queries: string[],
    regionCode: string,
    relevanceLanguage: string,
    fallbackReason: string,
    quotaUsedToday = 0
  ): TrendSignals {
    return {
      mode: "offline",
      badge: "Trend data: offline",
      queries,
      samples: [],
      topKeywords: [],
      commonHashtags: [],
      fetchedAt: new Date().toISOString(),
      regionCode,
      relevanceLanguage,
      quotaUsedToday,
      quotaRemaining: Math.max(0, this.safetyStop - quotaUsedToday),
      fallbackReason
    };
  }
}
