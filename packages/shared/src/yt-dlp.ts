import { spawn, type ChildProcess } from "node:child_process";
import { mapYtDlpError } from "./url-import.js";

export interface YtDlpResult {
  stdout: string;
  stderr: string;
}

export async function executeYtDlp(
  executable: string,
  args: string[],
  onOutput?: (line: string) => void,
  startProcess: (command: string, commandArgs: string[]) => ChildProcess = spawn
): Promise<YtDlpResult> {
  const child = startProcess(executable, args);
  let stdout = "";
  let stderr = "";
  const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
    const text = chunk.toString("utf8");
    if (target === "stdout") {
      stdout += text;
      if (stdout.length > 10 * 1024 * 1024) child.kill("SIGTERM");
    } else {
      stderr = `${stderr}${text}`.slice(-16_000);
    }
    onOutput?.(text);
  };
  child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

  const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });
  if (result.error) {
    throw new Error(mapYtDlpError(result.error.message));
  }
  if (stdout.length > 10 * 1024 * 1024) {
    throw new Error("YouTube returned oversized metadata.");
  }
  if (result.code !== 0) {
    throw new Error(mapYtDlpError(`${stderr}\n${stdout}`));
  }
  return { stdout, stderr };
}

export async function fetchYtDlpMetadata(url: string, executable: string) {
  const { stdout } = await executeYtDlp(executable, [
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--no-call-home",
    "--format",
    "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    url
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("YouTube returned invalid video metadata.");
  }
  return parsed;
}
