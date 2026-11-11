export type ReframeStrategyId = "blur-fit" | "center-crop";

export interface ReframeStrategy {
  id: ReframeStrategyId;
  buildVideoFilter(subtitles: string): string;
}

export const REFRAME_STRATEGIES: Record<ReframeStrategyId, ReframeStrategy> = {
  "blur-fit": {
    id: "blur-fit",
    buildVideoFilter: (subtitles) => [
      "[0:v]split=2[backgroundSource][foregroundSource]",
      "[backgroundSource]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920[background]",
      "[foregroundSource]scale=1080:1920:force_original_aspect_ratio=decrease[foreground]",
      `[background][foreground]overlay=(W-w)/2:(H-h)/2,${subtitles}[outv]`
    ].join(";")
  },
  "center-crop": {
    id: "center-crop",
    buildVideoFilter: (subtitles) => `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${subtitles}[outv]`
  }
};

export interface FfmpegRenderCommand {
  args: string[];
  filterComplex: string;
}

export function escapeFilterPath(path: string) {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,")
    .replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function buildFfmpegRenderCommand(
  inputPath: string,
  assPath: string,
  outputPath: string,
  startSeconds: number,
  endSeconds: number,
  reframeStrategy: ReframeStrategyId,
  hasAudio = true
): FfmpegRenderCommand {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
    throw new Error("Render trim boundaries must be valid");
  }

  const subtitles = `subtitles=filename='${escapeFilterPath(assPath)}'`;
  const videoFilter = REFRAME_STRATEGIES[reframeStrategy].buildVideoFilter(subtitles);
  const filterComplex = hasAudio
    ? `${videoFilter};[0:a:0]aresample=44100:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=1.35[aout]`
    : videoFilter;

  return {
    filterComplex,
    args: [
      "-hide_banner",       "-nostdin", "-y",
      "-ss", startSeconds.toFixed(3),
      "-i", inputPath,
      "-t", (endSeconds - startSeconds).toFixed(3),
      "-filter_complex", filterComplex,
      "-map", "[outv]",
      ...(hasAudio ? ["-map", "[aout]"] : []),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-threads", "2",
      "-filter_complex_threads", "2",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-progress", "pipe:1",
      "-nostats",
      outputPath
    ]
  };
}
