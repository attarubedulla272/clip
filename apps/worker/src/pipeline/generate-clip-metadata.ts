import { clipMetadataResultSchema } from "@clipforge/shared/clip-metadata";
import {
  WorkerAnalysisModel,
  WorkerClipMetadataModel,
  WorkerClipModel,
  WorkerJobModel,
  WorkerTranscriptModel,
  WorkerVideoModel
} from "../models.js";
import { config } from "../config.js";
import { OllamaProvider } from "../llm/ollama-provider.js";
import { GeminiProvider } from "../llm/gemini-provider.js";
import {
  generateMetadataWithFallback,
  type ClipMetadataCache,
  type MetadataProvider
} from "../llm/generate-clip-metadata.js";
import { YouTubeTrendProvider } from "../trends/trend-provider.js";

interface GenerateClipMetadataInput {
  userId: string;
  videoId: string;
  clipId: string;
  databaseJobId: string;
  attemptNumber: number;
}

export async function generateClipMetadata(
  input: GenerateClipMetadataInput,
  updateProgress: (progress: { stage: string; message: string; percent: number; etaSeconds?: number }) => Promise<void>
) {
  const [clip, video, analysis, transcript, metadata] = await Promise.all([
    WorkerClipModel.findOne({ _id: input.clipId, videoId: input.videoId }),
    WorkerVideoModel.findOne({ _id: input.videoId, userId: input.userId }),
    WorkerAnalysisModel.findOne({ videoId: input.videoId }),
    WorkerTranscriptModel.findOne({ videoId: input.videoId }),
    WorkerClipMetadataModel.findOne({ clipId: input.clipId, videoId: input.videoId })
  ]);
  if (!clip) throw new Error("The clip selected for metadata generation no longer exists");
  if (!video) throw new Error("The source video for metadata generation no longer exists");
  if (!clip.selectedForRendering && clip.renderStatus !== "ready") {
    throw new Error("Select or render this clip before generating metadata");
  }
  if (!analysis) throw new Error("Video type analysis is unavailable");
  if (!metadata) throw new Error("Metadata generation settings are unavailable");

  const publish = async (stage: string, message: string, percent: number, etaSeconds?: number) => {
    const progress = { stage, message, percent, ...(etaSeconds === undefined ? {} : { etaSeconds }) };
    await Promise.all([
      WorkerClipMetadataModel.updateOne({ _id: metadata._id }, {
        $set: { generationStatus: "processing", generationProgress: progress }
      }),
      WorkerJobModel.updateOne({ _id: input.databaseJobId }, {
        $set: {
          status: "processing",
          attemptsMade: input.attemptNumber,
          startedAt: new Date(),
          progress
        },
        $unset: { failedReason: 1 }
      }),
      updateProgress(progress)
    ]);
  };

  await publish("metadata", "Preparing metadata providers", 5, 15);
  const originalCredit = metadata.includeOriginalCredit && video.source === "url" && video.sourceUrl
    ? `${video.channel ? `${video.channel} · ` : ""}${video.sourceUrl}`
    : undefined;
  const providers: MetadataProvider[] = [];
  const unavailableReasons: string[] = [];
  for (const name of config.llmProviderOrder) {
    if (name === "gemini") {
      if (!metadata.useGemini) continue;
      if (!process.env.GEMINI_API_KEY?.trim()) {
        unavailableReasons.push("Gemini was skipped because GEMINI_API_KEY is not configured");
        continue;
      }
      try {
        providers.push(new GeminiProvider());
      } catch {
        unavailableReasons.push("Gemini configuration is invalid");
      }
    } else if (name === "ollama") {
      try {
        const ollama = new OllamaProvider();
        const baseUrl = new URL(process.env.OLLAMA_BASE_URL ?? "http://host.docker.internal:11434");
        try {
          const probe = await fetch(`${baseUrl.origin}${baseUrl.pathname.replace(/\/+$/, "")}/api/tags`, {
            signal: AbortSignal.timeout(config.metadataOllamaProbeTimeoutMs)
          });
          if (!probe.ok) throw new Error(`Ollama probe returned HTTP ${probe.status}`);
          providers.push(ollama);
        } catch {
          unavailableReasons.push("Ollama was unavailable or did not respond during the fast probe");
        }
      } catch {
        unavailableReasons.push("Ollama configuration is invalid");
      }
    }
  }
  await publish("metadata", `Generating metadata (${providers.map((provider) => provider.providerName).join(" → ") || "Offline"})`, 10, 15);
  await publish("metadata", "Fetching trend signals from YouTube or offline cache", 12, 20);
  const trendSignals = await new YouTubeTrendProvider().fetch({
    clipText: clip.transcriptText,
    topicLabel: clip.topicLabel,
    videoType: analysis.videoType,
    language: transcript?.language ?? "en"
  });
  const cache: ClipMetadataCache = {
    async get(contentHash) {
      const cached = await WorkerClipMetadataModel.findOne({
        contentHash,
        result: { $exists: true },
        mode: { $in: ["AI", "Offline"] },
        edited: { $ne: true }
      }).select("result mode provider fallbackReason warnings").lean();
      if (!cached || !cached.result || !cached.mode) return undefined;
      const result = clipMetadataResultSchema.safeParse(cached.result);
      if (!result.success) return undefined;
      return {
        result: result.data,
        mode: cached.mode,
        provider: cached.provider ?? (cached.mode === "Offline" ? "Offline" : "Ollama"),
        ...(cached.fallbackReason ? { fallbackReason: cached.fallbackReason } : {}),
        warnings: cached.warnings ?? {}
      };
    },
    async set(contentHash, value) {
      await WorkerClipMetadataModel.updateOne({ _id: metadata._id }, {
        $set: {
          contentHash,
          result: value.result,
          mode: value.mode,
          provider: value.provider,
          warnings: value.warnings,
          trendSignals,
          ...(value.fallbackReason ? { fallbackReason: value.fallbackReason } : {}),
          edited: false,
          generationStatus: "processing"
        }
      });
    }
  };
  const generated = await generateMetadataWithFallback({
    transcript: clip.transcriptText,
    videoTitle: video.sourceTitle ?? video.originalName,
    videoType: analysis.videoType,
    language: metadata.language,
    tone: metadata.tone,
    includeOriginalCredit: Boolean(originalCredit),
    useGemini: metadata.useGemini,
    trendSignals,
    nicheQueries: trendSignals.queries,
    ...(originalCredit ? { originalCredit } : {})
  }, {
    language: metadata.language,
    tone: metadata.tone,
    includeOriginalCredit: metadata.includeOriginalCredit,
    useGemini: metadata.useGemini
  }, providers, cache, unavailableReasons, config.llmProviderOrder);

  const completedAt = new Date();
  const finalProgress = { stage: "complete", message: `${generated.provider} metadata ready`, percent: 100, etaSeconds: 0 };
  await Promise.all([
    WorkerClipMetadataModel.updateOne({ _id: metadata._id }, {
      $set: {
        contentHash: generated.contentHash,
        result: generated.result,
        mode: generated.mode,
        provider: generated.provider,
        warnings: generated.warnings,
        trendSignals,
        ...(generated.fallbackReason ? { fallbackReason: generated.fallbackReason } : {}),
        edited: false,
        generationStatus: "idle",
        generationProgress: finalProgress,
        generatedAt: completedAt
      },
      $unset: {
        generationError: 1,
        ...(generated.fallbackReason ? {} : { fallbackReason: 1 })
      }
    }),
    WorkerJobModel.updateOne({ _id: input.databaseJobId, status: { $nin: ["completed", "failed"] } }, {
      $set: { status: "completed", completedAt, progress: finalProgress },
      $unset: { failedReason: 1 }
    }),
    updateProgress(finalProgress)
  ]);
}
