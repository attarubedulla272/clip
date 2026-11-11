import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MergedTranscript, TranscriptChunk } from "./chunks.js";
import { mergeChunkTranscripts } from "./chunks.js";

export interface TranscriptionProgress {
  completedChunks: number;
  totalChunks: number;
  completedAudioSeconds: number;
  etaSeconds?: number;
  message: string;
}

export interface TranscriptionResult extends MergedTranscript {
  language: string;
  languageChunks: Array<{ language: string; durationSeconds: number }>;
  durationSeconds: number;
}

export function resolveDetectedLanguage(
  chunks: Array<{ language: string; durationSeconds: number }>,
  fallback = "und"
) {
  const durations = new Map<string, number>();
  for (const chunk of chunks) {
    if (chunk.language && Number.isFinite(chunk.durationSeconds) && chunk.durationSeconds > 0) {
      durations.set(chunk.language, (durations.get(chunk.language) ?? 0) + chunk.durationSeconds);
    }
  }
  return [...durations].sort((left, right) => right[1] - left[1])[0]?.[0] ?? fallback;
}

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
const scriptPath = resolve(workerRoot, "python/transcribe.py");

export async function transcribeAudio(
  audioPath: string,
  outputPath: string,
  options: {
    model: string;
    chunkSeconds: number;
    modelDirectory: string;
    pythonPath: string;
    onProgress: (progress: TranscriptionProgress) => Promise<void>;
  }
): Promise<TranscriptionResult> {
  const child = spawn(options.pythonPath, [
    scriptPath,
    "--audio", audioPath,
    "--output", outputPath,
    "--model", options.model,
    "--chunk-seconds", String(options.chunkSeconds),
    "--model-dir", options.modelDirectory
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" }
  });

  let pending = "";
  let stderr = "";
  let progressFailure: Error | undefined;
  let progressChain = Promise.resolve();
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: string } & Partial<TranscriptionProgress>;
        if (event.type === "progress" && typeof event.completedChunks === "number" && typeof event.totalChunks === "number") {
          const progress: TranscriptionProgress = {
            completedChunks: event.completedChunks,
            totalChunks: event.totalChunks,
            completedAudioSeconds: event.completedAudioSeconds ?? 0,
            ...(typeof event.etaSeconds === "number" ? { etaSeconds: event.etaSeconds } : {}),
            message: event.message ?? `Transcribed chunk ${event.completedChunks}/${event.totalChunks}`
          };
          progressChain = progressChain.then(() => options.onProgress(progress)).catch((error: unknown) => {
            progressFailure = error instanceof Error ? error : new Error("Could not save transcription progress");
            child.kill("SIGTERM");
          });
        }
      } catch {
        progressFailure = new Error("Transcription worker returned malformed progress data");
        child.kill("SIGTERM");
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  await progressChain;
  if (progressFailure) throw progressFailure;
  if (exitCode !== 0) {
    const detail = stderr.trim().split("\n").slice(-5).join(" ").slice(-600);
    throw new Error(`Local transcription failed${detail ? `: ${detail}` : " with a non-zero exit code"}`);
  }

  const result = JSON.parse(await readFile(outputPath, "utf8")) as {
    language: string;
    languageChunks?: Array<{ language: string; durationSeconds: number }>;
    durationSeconds: number;
    chunks: TranscriptChunk[];
  };
  const merged = mergeChunkTranscripts(result.chunks);
  const languageChunks = result.languageChunks ?? [];
  return {
    ...merged,
    language: resolveDetectedLanguage(languageChunks, result.language),
    languageChunks,
    durationSeconds: result.durationSeconds
  };
}
