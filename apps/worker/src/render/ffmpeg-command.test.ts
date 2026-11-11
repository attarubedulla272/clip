import { describe, expect, it } from "vitest";
import { buildFfmpegRenderCommand } from "./ffmpeg-command.js";

describe("ffmpeg render command", () => {
  it("builds a blur-fit 1080x1920, H.264/AAC render with bounded threads and progress output", () => {
    const command = buildFfmpegRenderCommand(
      "/data/source.mp4",
      "/tmp/captions.ass",
      "/tmp/output.mp4",
      12.5,
      42.5,
      "blur-fit"
    );

    expect(command.filterComplex).toContain("scale=270:480");
    expect(command.filterComplex).toContain("boxblur=10:2");
    expect(command.filterComplex).toContain("scale=1080:1920");
    expect(command.args).toEqual(expect.arrayContaining([
      "-ss", "12.500", "-t", "30.000",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-threads", "2", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart",
      "-progress", "pipe:1"
    ]));
  });

  it("builds center-crop framing and rejects invalid time ranges", () => {
    const command = buildFfmpegRenderCommand("source.mp4", "captions.ass", "output.mp4", 0, 5, "center-crop");
    expect(command.filterComplex).toContain("crop=1080:1920");
    expect(command.filterComplex).toContain("aresample=44100:async=1:first_pts=0");
    expect(command.filterComplex).toContain("channel_layouts=stereo");
    expect(command.filterComplex).toContain("[aout]");
    expect(() => buildFfmpegRenderCommand("source.mp4", "captions.ass", "output.mp4", 5, 5, "blur-fit")).toThrow(/boundaries/);
  });

});
