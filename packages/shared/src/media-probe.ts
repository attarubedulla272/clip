import { spawn } from "node:child_process";

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    duration?: string;
  }>;
}

export class MediaProbeError extends Error {
  constructor(
    public readonly statusCode: 413 | 415,
    message: string
  ) {
    super(message);
    this.name = "MediaProbeError";
  }
}

export interface MediaInfo {
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export async function probeMediaFile(filePath: string, ffprobePath: string): Promise<MediaInfo> {
  const child = spawn(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,duration",
    "-of", "json",
    filePath
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  const childResult = new Promise<{ code: number | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code }));
  });
  let result: { code: number | null };
  try {
    result = await childResult;
  } catch (error) {
    throw new MediaProbeError(415, `Could not inspect uploaded media: ${error instanceof Error ? error.message : "ffprobe failed"}`);
  }

  if (result.code !== 0) {
    throw new MediaProbeError(415, `The uploaded file is not valid media${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`);
  }

  let probe: FfprobeOutput;
  try {
    probe = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new MediaProbeError(415, "The uploaded file did not contain readable media metadata");
  }

  const usableStreams = (probe.streams ?? []).filter((stream) =>
    typeof stream.codec_type === "string" && typeof stream.codec_name === "string" && stream.codec_name !== "unknown"
  );
  const hasAudio = usableStreams.some((stream) => stream.codec_type === "audio");
  const hasVideo = usableStreams.some((stream) => stream.codec_type === "video");
  if (!hasAudio && !hasVideo) {
    throw new MediaProbeError(415, "The file must contain at least one valid audio or video stream");
  }

  const formatDuration = Number(probe.format?.duration);
  const streamDurations = usableStreams.map((stream) => Number(stream.duration)).filter(Number.isFinite);
  const durationSeconds = Number.isFinite(formatDuration) && formatDuration > 0
    ? formatDuration
    : Math.max(0, ...streamDurations);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaProbeError(415, "The media duration could not be determined");
  }

  return { durationSeconds, hasAudio, hasVideo };
}

export function enforceDurationLimit(durationSeconds: number, maximumSeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaProbeError(415, "The media duration could not be determined");
  }
  if (durationSeconds > maximumSeconds) {
    throw new MediaProbeError(413, `Video duration (${Math.ceil(durationSeconds)} seconds) exceeds the configured ${maximumSeconds}-second limit`);
  }
}
