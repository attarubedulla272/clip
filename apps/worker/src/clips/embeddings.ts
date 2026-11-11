import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_NAME = process.env.FASTEMBED_MODEL_NAME ??
  "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
const MODEL_CACHE_DIR = process.env.FASTEMBED_CACHE_DIR ?? "/models/fastembed";
const MODEL_DIMENSIONS = 384;
const MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
const scriptPath = resolve(workerRoot, "python/embed_sentences.py");

export interface EmbeddingProgress {
  completed: number;
  total: number;
}

export interface EmbeddingProvider {
  readonly modelName: string;
  readonly cacheDir: string;
  embedSentences(
    sentences: string[],
    options?: {
      onProgress?: (progress: EmbeddingProgress) => Promise<void>;
    }
  ): Promise<number[][]>;
  release(): Promise<void>;
}

export class FastEmbedEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly cacheDir: string;

  constructor(options: { modelName?: string; cacheDir?: string; pythonPath?: string } = {}) {
    this.modelName = options.modelName ?? MODEL_NAME;
    this.cacheDir = options.cacheDir ?? MODEL_CACHE_DIR;
  }

  async embedSentences(
    sentences: string[],
    options: { onProgress?: (progress: EmbeddingProgress) => Promise<void> } = {}
  ): Promise<number[][]> {
    const embedOptions: {
      modelName: string;
      cacheDir: string;
      onProgress?: (progress: EmbeddingProgress) => Promise<void>;
    } = {
      modelName: this.modelName,
      cacheDir: this.cacheDir
    };
    if (options.onProgress) {
      embedOptions.onProgress = options.onProgress;
    }
    return embedSentences(sentences, embedOptions);
  }

  async release(): Promise<void> {
    return;
  }
}

export async function embedSentences(
  sentences: string[],
  options: {
    pythonPath?: string;
    cacheDir?: string;
    modelName?: string;
    onProgress?: (progress: EmbeddingProgress) => Promise<void>;
  } = {}
): Promise<number[][]> {
  if (sentences.length === 0) return [];
  if (sentences.some((sentence) => typeof sentence !== "string" || sentence.length === 0)) {
    throw new Error("Embedding sentences must be non-empty strings");
  }

  const venv = process.env.WHISPER_VENV ?? "/opt/whisper-venv";
  const pythonPath = options.pythonPath ?? process.env.WHISPER_PYTHON ?? `${venv}/bin/python`;
  const child = spawn(pythonPath, [
    scriptPath,
    "--model", options.modelName ?? MODEL_NAME,
    "--cache-dir", options.cacheDir ?? MODEL_CACHE_DIR,
    "--threads", "2"
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_DISABLE_TELEMETRY: "1" }
  });

  let stdoutPending = "";
  let stdoutBytes = 0;
  let stderr = "";
  let result: number[][] | undefined;
  let failure: Error | undefined;
  let progressChain = Promise.resolve();

  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_OUTPUT_BYTES) {
      failure = new Error("Sentence embedding output exceeded the safe size limit");
      child.kill("SIGTERM");
      return;
    }

    stdoutPending += chunk;
    const lines = stdoutPending.split(/\r?\n/);
    stdoutPending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        const event = JSON.parse(trimmed) as {
          type?: unknown;
          completed?: unknown;
          total?: unknown;
          embeddings?: unknown;
        };
        if (event.type === "progress" &&
          typeof event.completed === "number" &&
          typeof event.total === "number" &&
          options.onProgress) {
          progressChain = progressChain.then(() => options.onProgress!({
            completed: event.completed as number,
            total: event.total as number
          })).catch((error: unknown) => {
            failure = error instanceof Error ? error : new Error("Could not save embedding progress");
            child.kill("SIGTERM");
          });
        } else if (event.type === "result" && Array.isArray(event.embeddings)) {
          result = event.embeddings as number[][];
        }
      } catch {
        failure = new Error("Sentence embedding worker returned malformed JSON");
        child.kill("SIGTERM");
      }
    }
  });

  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  let stdinError: Error | undefined;
  child.stdin.on("error", (error) => {
    stdinError = error;
  });

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
    child.stdin.end(JSON.stringify({ sentences }));
  });
  await progressChain;
  if (failure) throw failure;
  if (exitCode !== 0) {
    const detail = stderr.trim().split("\n").slice(-4).join(" ").slice(0, 600);
    const cause = stdinError ? ` (${stdinError.message})` : "";
    throw new Error(`Local sentence embedding failed${detail ? `: ${detail}` : cause || " with a non-zero exit code"}`);
  }
  if (!result || result.length !== sentences.length ||
    result.some((vector) => vector.length !== MODEL_DIMENSIONS || vector.some((value) => !Number.isFinite(value)))) {
    throw new Error("Local sentence embedding returned an invalid vector set");
  }
  return result;
}
