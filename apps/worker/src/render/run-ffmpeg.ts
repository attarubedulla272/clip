import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import type { FfmpegRenderCommand } from "./ffmpeg-command.js";

export interface RenderProgress {
  message: string;
  percent: number;
  etaSeconds: number;
}

function parseClock(value: string) {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export async function runFfmpegRender(
  ffmpegPath: string,
  command: FfmpegRenderCommand,
  durationSeconds: number,
  onProgress: (progress: RenderProgress) => Promise<void>
) {
  const startedAt = performance.now();
  const child = spawn(ffmpegPath, command.args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let lastPercent = -1;
  let lastUpdateAt = 0;
  let updateChain = Promise.resolve();
  let progressError: unknown;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });

  const report = (seconds: number) => {
    const percent = Math.max(0, Math.min(99, Math.floor(seconds / durationSeconds * 100)));
    const now = performance.now();
    if (percent === lastPercent && now - lastUpdateAt < 1_000) return;
    lastPercent = percent;
    lastUpdateAt = now;
    const elapsedSeconds = (now - startedAt) / 1_000;
    const etaSeconds = percent > 0 ? Math.ceil(elapsedSeconds * (100 - percent) / percent) : Math.ceil(durationSeconds);
    updateChain = updateChain.then(() => onProgress({
      message: `Rendering video · ${percent}%`,
      percent,
      etaSeconds
    })).catch((error: unknown) => {
      progressError = error;
    });
  };

  const lines = createInterface({ input: child.stdout });
  let progressValues = new Map<string, string>();
  lines.on("line", (line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) return;
    progressValues.set(line.slice(0, separator), line.slice(separator + 1));
    if (line.startsWith("progress=")) {
      const outTime = progressValues.get("out_time");
      const microseconds = Number(progressValues.get("out_time_us"));
      const milliseconds = Number(progressValues.get("out_time_ms"));
      const seconds = Number.isFinite(microseconds) && microseconds > 0
        ? microseconds / 1_000_000
        : Number.isFinite(milliseconds) && milliseconds > 0
          ? milliseconds / 1_000_000
          : outTime ? parseClock(outTime) : undefined;
      if (seconds !== undefined) report(seconds);
      progressValues = new Map();
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  lines.close();
  await updateChain;
  if (progressError) throw new Error("Could not save render progress", { cause: progressError });
  if (exitCode !== 0) {
    const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(-1000);
    throw new Error(detail || `ffmpeg exited with code ${exitCode}`);
  }
  await onProgress({ message: "Render complete", percent: 100, etaSeconds: 0 });
}
