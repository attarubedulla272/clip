import { readFile } from "node:fs/promises";
import { Types } from "mongoose";
import { LocalDiskStorage } from "@clipforge/shared/storage";
import { parseTranscriptWords } from "@clipforge/shared/clip-trim";
import {
  WorkerClipScoreCacheModel,
  WorkerAnalysisModel,
  WorkerJobModel,
  WorkerTranscriptModel,
  WorkerUserModel,
  WorkerVideoModel
} from "../models.js";
import type { TranscriptWord } from "../transcription/chunks.js";
import { measureAudioEnergyBySecond } from "../clips/audio-energy.js";
import { findClipCandidatesWithDiagnostics } from "../clips/shortlist.js";
import { OllamaProvider } from "../llm/ollama-provider.js";
import { scoreClipWithFallback, type ClipScoreCache } from "../llm/score-clip.js";
import { createStagedClipDocument, replaceVideoClips } from "../clips/clip-replacement.js";
import {
  cheapCandidateScores,
  rankScoredCandidates,
  selectDiverseCandidatesWithDiagnostics,
  type RankedClipCandidate
} from "../clips/ranking.js";
import { FastEmbedEmbeddingProvider } from "../clips/embeddings.js";
import { cosineSimilarity } from "../clips/topics.js";
import { CLIP_DETECTION_CONFIG } from "../clips/ranking-config.js";
import { GeminiProvider } from "../llm/gemini-provider.js";
import { config } from "../config.js";
import type { ClipTopicSegment } from "@clipforge/shared/clip-topics";
import type { ClipFunnelRemoval } from "@clipforge/shared/clip-funnel";
import { createClipFunnelReport } from "../clips/funnel.js";
import { finalizeSelectedClip } from "../clips/final-boundaries.js";

interface FindClipsInput {
  userId: string;
  videoId: string;
  databaseJobId: string;
  attemptNumber: number;
  useGemini?: boolean;
}

interface FindClipsProgress {
  stage: string;
  message: string;
  percent: number;
}

const storageRoot = process.env.STORAGE_ROOT ?? "./data";
const storage = new LocalDiskStorage(storageRoot);
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const ollama = new OllamaProvider();
const scoreCache: ClipScoreCache = {
  async get(contentHash) {
    const cached = await WorkerClipScoreCacheModel.findOne({ contentHash }).lean<{ contentHash: string; result: unknown } | null>();
    if (!cached || typeof cached.result !== "object" || cached.result === null) return undefined;
    return cached.result as any;
  },
  async set(contentHash, result) {
    const cached = await WorkerClipScoreCacheModel.findOneAndUpdate(
      { contentHash },
      { $setOnInsert: { contentHash, result } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<{ contentHash: string; result: unknown } | null>();
    if (!cached || typeof cached.result !== "object" || cached.result === null) throw new Error("Could not save the clip score cache entry");
    return cached.result as any;
  }
};

export async function findVideoClips(
  input: FindClipsInput,
  updateProgress: (progress: FindClipsProgress) => Promise<void>
) {
  const { userId, videoId, databaseJobId, attemptNumber } = input;
  const video = await WorkerVideoModel.findOne({ _id: videoId, userId });
  if (!video || video.status !== "ready") {
    throw new Error("Analyze this video before looking for clips.");
  }
  if (typeof video.durationSeconds !== "number" || video.durationSeconds <= 0) {
    throw new Error("The video duration is missing; upload the video again before finding clips.");
  }
  const transcript = await WorkerTranscriptModel.findOne({ videoId });
  if (!transcript) throw new Error("The saved transcript is missing; analyze the video before finding clips.");

  const publish = async (progress: FindClipsProgress) => {
    await WorkerJobModel.updateOne({ _id: databaseJobId }, { $set: { status: "processing", progress } });
    await updateProgress(progress);
  };

  await WorkerJobModel.updateOne(
    { _id: databaseJobId },
    {
      $set: {
        status: "processing",
        attemptsMade: attemptNumber,
        startedAt: new Date(),
        progress: { stage: "transcript", message: "Reading the saved word-level transcript", percent: 5 }
      },
      $unset: { failedReason: 1 }
    }
  );
  await publish({ stage: "transcript", message: "Reading the saved word-level transcript", percent: 5 });

  const transcriptFile = JSON.parse(await readFile(storage.pathFor(userId, transcript.wordsPath), "utf8")) as {
    words?: unknown;
  };
  if (!Array.isArray(transcriptFile.words)) throw new Error("The saved word-level transcript has an invalid format.");
  const parsedWords = parseTranscriptWords(transcriptFile.words);
  const words: TranscriptWord[] = parsedWords.words;
  if (parsedWords.skippedZeroDurationWords > 0) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "clips.transcript.zero_duration_words.skipped",
      videoId,
      count: parsedWords.skippedZeroDurationWords
    }));
  }
  if (words.length === 0) throw new Error("The saved transcript has no words to search for clips.");

  await publish({ stage: "audio-energy", message: "Checking audio energy with ffmpeg", percent: 20 });
  const audioEnergyBySecond = await measureAudioEnergyBySecond(
    ffmpegPath,
    storage.pathFor(userId, video.storageKey)
  );
  const analysis = await WorkerAnalysisModel.findOne({ videoId }).select("topicSegments").lean();
  const topicSegments = (analysis?.topicSegments ?? []) as ClipTopicSegment[];
  await publish({ stage: "shortlist", message: "Finding sentence-bounded moments from transcript signals", percent: 30 });
  const generation = findClipCandidatesWithDiagnostics(
    words,
    video.durationSeconds,
    audioEnergyBySecond,
    CLIP_DETECTION_CONFIG.maximumCandidatesBeforeSelection,
    undefined,
    CLIP_DETECTION_CONFIG.maximumCandidatesBeforeSelection,
    topicSegments
  );
  const candidates = generation.candidates;
  const funnelRemovals: ClipFunnelRemoval[] = [...generation.removals];
  if (candidates.length === 0) {
    await replaceVideoClips(new Types.ObjectId(videoId), []);
  }

  if (candidates.length > 0) {
    await publish({ stage: "embeddings", message: `Checking semantic similarity for ${candidates.length} candidate windows`, percent: 35 });
    const topicById = new Map(topicSegments.map((topic) => [topic.id, topic]));
    const uniqueTopics = [...new Map(candidates
      .map((candidate) => topicById.get(candidate.topicId ?? ""))
      .filter((topic): topic is ClipTopicSegment => Boolean(topic))
      .map((topic) => [topic.id, topic])).values()];
    const embeddingProvider = new FastEmbedEmbeddingProvider();
    try {
      const inputs = [
        ...candidates.map((candidate) => candidate.transcriptText),
        ...uniqueTopics.map((topic) => topic.text)
      ];
      const vectors = await embeddingProvider.embedSentences(inputs, {
        onProgress: async (progress) => publish({
          stage: "embeddings",
          message: `Embedding candidates (${progress.completed}/${progress.total})`,
          percent: Math.min(49, 35 + Math.round(progress.completed / Math.max(1, progress.total) * 14))
        })
      });
      candidates.forEach((candidate, index) => {
        candidate.embedding = vectors[index]!;
        const topic = topicById.get(candidate.topicId ?? "");
        const topicIndex = topic ? uniqueTopics.findIndex((entry) => entry.id === topic.id) : -1;
        const topicVector = topicIndex >= 0 ? vectors[candidates.length + topicIndex] : undefined;
        if (topicVector) {
          candidate.topicCoherenceScore = Math.round(Math.max(0, Math.min(1, cosineSimilarity(candidate.embedding, topicVector))) * 100);
        }
      });
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        event: "clips.find.embedding_failed",
        videoId,
        message: error instanceof Error ? error.message : "Unknown embedding error",
        fallback: "lexical-similarity-and-topic-overlap"
      }));
      candidates.forEach((candidate) => {
        candidate.embedding = [];
      });
    } finally {
      await embeddingProvider.release();
    }
  }

  const llmCandidates = cheapCandidateScores(candidates)
    .slice(0, CLIP_DETECTION_CONFIG.maximumCandidatesForLlm);
  const scoredCandidateSet = new Set(llmCandidates.map(({ candidate }) => candidate));
  for (const candidate of candidates) {
    if (scoredCandidateSet.has(candidate)) continue;
    funnelRemovals.push({
      start: candidate.start,
      end: candidate.end,
      reason: "scoring-shortlist",
      detail: `Only the top ${CLIP_DETECTION_CONFIG.maximumCandidatesForLlm} candidates by cheap-factor score are sent to the LLM.`
    });
  }
  await publish({
    stage: "shortlist",
    message: `${candidates.length} candidates generated · ${llmCandidates.length} top candidates sent for scoring`,
    percent: 50
  });
  let funnelReport = createClipFunnelReport(
    {
      attemptedCount: generation.attemptedCount,
      generatedCount: generation.generatedCount,
      candidatePoolCount: candidates.length,
      scoredCount: 0,
      selectedCount: 0
    },
    funnelRemovals
  );
  await WorkerJobModel.updateOne({ _id: databaseJobId }, { $set: { findClipsDiagnostics: funnelReport } });

  const scoredCandidates = [];
  const providers = [];
  for (const providerName of config.llmProviderOrder) {
    if (providerName === "gemini" && input.useGemini && process.env.GEMINI_API_KEY?.trim()) {
      providers.push(new GeminiProvider());
    } else if (providerName === "ollama") {
      providers.push(ollama);
    }
  }
  for (const [index, { candidate }] of llmCandidates.entries()) {
    const scored = await scoreClipWithFallback({
      transcriptText: candidate.transcriptText,
      signalsFound: candidate.signalsFound,
      durationSeconds: candidate.end - candidate.start,
      topicLabel: candidate.topicLabel ?? "general topic",
      heuristicSignalScore: candidate.heuristicSignalScore ?? 50,
      heuristicSignalReason: candidate.reason,
      topicCoherenceScore: candidate.topicCoherenceScore ?? 50,
      boundaryQualityScore: candidate.boundaryQualityScore ?? 50,
      boundaryQualityReason: candidate.boundaryQualityReason ?? "Sentence boundaries are intact.",
      ruleStandalone: candidate.ruleStandalone ?? true
    }, providers, scoreCache);
    scoredCandidates.push({ candidate, contentHash: scored.contentHash, result: scored.result, cached: scored.cached });
    await publish({
      stage: "scoring",
      message: `Scored candidate ${index + 1} of ${llmCandidates.length} · ${scored.result.scoringMode}${scored.cached ? " · cached" : ""}`,
      percent: 50 + Math.round((index + 1) / Math.max(1, llmCandidates.length) * 32)
    });
  }
  funnelReport = createClipFunnelReport(
    {
      attemptedCount: generation.attemptedCount,
      generatedCount: generation.generatedCount,
      candidatePoolCount: candidates.length,
      scoredCount: scoredCandidates.length,
      selectedCount: 0
    },
    funnelRemovals
  );
  await WorkerJobModel.updateOne({ _id: databaseJobId }, { $set: { findClipsDiagnostics: funnelReport } });

  const selection = selectDiverseCandidatesWithDiagnostics(rankScoredCandidates(scoredCandidates));
  funnelRemovals.push(...selection.removals);
  const boundaryFinalized: RankedClipCandidate[] = [];
  const standaloneProviders = [...providers].sort((left, right) =>
    (left.providerName === "Gemini" ? 0 : 1) - (right.providerName === "Gemini" ? 0 : 1)
  );
  for (const [index, ranked] of selection.selected.entries()) {
    const finalized = await finalizeSelectedClip(words, ranked.candidate, standaloneProviders);
    const factorBreakdown = {
      ...ranked.factorBreakdown,
      boundaryQuality: {
        ...ranked.factorBreakdown.boundaryQuality,
        score: finalized.candidate.boundaryQualityScore ?? ranked.factorBreakdown.boundaryQuality.score,
        contribution: (finalized.candidate.boundaryQualityScore ?? ranked.factorBreakdown.boundaryQuality.score) *
          ranked.factorBreakdown.boundaryQuality.weight,
        reason: finalized.candidate.boundaryQualityReason ?? ranked.factorBreakdown.boundaryQuality.reason
      }
    };
    const score = Math.round(Object.values(factorBreakdown).reduce((sum, factor) => sum + factor.contribution, 0));
    const finalizedCandidate = {
      ...finalized.candidate,
      boundaryChanges: finalized.changes,
      standaloneCheck: finalized.standaloneCheck
    };
    const conflictsWithFinal = boundaryFinalized.find(({ candidate: selected }) =>
      finalizedCandidate.start < selected.end && finalizedCandidate.end > selected.start
    );
    if (conflictsWithFinal) {
      funnelRemovals.push({
        start: finalizedCandidate.start,
        end: finalizedCandidate.end,
        reason: "overlap",
        detail: "Final context adjustment overlapped another selected moment; the higher-ranked clip was kept."
      });
      continue;
    }
    boundaryFinalized.push({
      ...ranked,
      score,
      factorBreakdown,
      candidate: finalizedCandidate
    });
    await publish({
      stage: "boundaries",
      message: `Checking context and payoff boundaries for selected clip ${index + 1} of ${selection.selected.length}`,
      percent: 84 + Math.round((index + 1) / Math.max(1, selection.selected.length) * 12)
    });
  }
  const selectedCandidates = boundaryFinalized;
  funnelReport = createClipFunnelReport(
    {
      attemptedCount: generation.attemptedCount,
      generatedCount: generation.generatedCount,
      candidatePoolCount: candidates.length,
      scoredCount: scoredCandidates.length,
      selectedCount: selectedCandidates.length
    },
    funnelRemovals
  );
  await WorkerJobModel.updateOne(
    { _id: databaseJobId },
    { $set: { findClipsDiagnostics: funnelReport } }
  );
  const replacementDocuments = selectedCandidates.map((ranked) =>
    createStagedClipDocument(new Types.ObjectId(videoId), {
      ...ranked,
      finalScore: ranked.score,
      factorBreakdown: ranked.factorBreakdown
    })
  );
  await publish({ stage: "saving", message: "Saving validated candidates without replacing existing clips", percent: 99 });
  await replaceVideoClips(new Types.ObjectId(videoId), replacementDocuments);

  await publish({
    stage: "complete",
    message: selectedCandidates.length > 0
      ? `Selected ${selectedCandidates.length} diverse clips from ${candidates.length} candidates`
      : "No 15–60 second moments matched the current transcript signals",
    percent: 100
  });
  const previous = await WorkerJobModel.findOneAndUpdate(
    { _id: databaseJobId, status: { $nin: ["completed", "failed"] } },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        progress: {
          stage: "complete",
          message: selectedCandidates.length > 0 ? `Selected ${selectedCandidates.length} diverse clips` : "No clip candidates found",
          percent: 100
        }
      },
      $unset: { failedReason: 1 }
    },
    { new: false }
  );
  if (previous) {
    await WorkerUserModel.updateOne({ _id: userId, activeAnalysisJobs: { $gt: 0 } }, { $inc: { activeAnalysisJobs: -1 } });
  }
}
