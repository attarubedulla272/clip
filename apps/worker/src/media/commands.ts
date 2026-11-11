import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runMediaCommand(binary: string, args: string[], label: string) {
  try {
    await execFileAsync(binary, args, { maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim().split("\n").slice(-4).join(" ").slice(-500)
      : "";
    throw new Error(`${label} failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
}

export async function extractMonoPcmAudio(ffmpegPath: string, inputPath: string, outputPath: string) {
  await runMediaCommand(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    outputPath
  ], "Audio extraction");
}
