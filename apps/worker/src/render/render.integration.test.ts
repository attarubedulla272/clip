import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { generateAssSubtitles } from "./ass.js";
import { buildFfmpegRenderCommand } from "./ffmpeg-command.js";

const enabled = process.env.RUN_RENDER_INTEGRATION === "true";
const benchmarkEnabled = process.env.RUN_RENDER_BENCHMARK === "true";
const execFileAsync = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe";

describe.skipIf(!enabled)("short clip render integration", () => {
  it("renders a five-second 1080x1920 clip with burned-in Hindi captions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clipforge-render-integration-"));
    const inputPath = join(workspace, "source.mp4");
    const assPath = join(workspace, "captions.ass");
    const outputPath = join(workspace, "rendered.mp4");

    try {
      await execFileAsync(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=15",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "5",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k",
        inputPath
      ]);
      const words = [
        { text: " Latin", start: 0.1, end: 0.3 },
        { text: " captions", start: 0.31, end: 0.5 },
        { text: " नमस्ते", start: 0.55, end: 0.9 },
        { text: " दुनिया।", start: 0.95, end: 1.3 },
        { text: " यह", start: 1.5, end: 1.7 },
        { text: " एक", start: 1.75, end: 1.9 },
        { text: " परीक्षण", start: 1.95, end: 2.4 },
        { text: " తెలుగు", start: 2.6, end: 3.1 },
        { text: " పరీక్ష.", start: 3.2, end: 3.8 }
      ];
      await writeFile(assPath, generateAssSubtitles(words, 0, 5));
      const command = buildFfmpegRenderCommand(inputPath, assPath, outputPath, 0, 5, "blur-fit");
      await execFileAsync(ffmpegPath, command.args, { maxBuffer: 2 * 1024 * 1024 });
      const subtitles = await readFile(assPath, "utf8");
      expect(subtitles).toContain("Latin captions");
      expect(subtitles).toContain("नमस्ते\\N दुनिया।");
      expect(subtitles).toContain("తెలుగు పరీక్ష.");

      const { stdout } = await execFileAsync(ffprobePath, [
        "-v", "error",
        "-show_entries", "stream=codec_type,codec_name,width,height",
        "-show_entries", "format=duration",
        "-of", "json",
        outputPath
      ]);
      const result = JSON.parse(stdout) as {
        streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>;
        format: { duration: string };
      };
      const video = result.streams.find((stream) => stream.codec_type === "video");
      const audio = result.streams.find((stream) => stream.codec_type === "audio");
      expect(video).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
      expect(audio).toMatchObject({ codec_name: "aac" });
      expect(Number(result.format.duration)).toBeGreaterThan(4.8);
      expect(Number(result.format.duration)).toBeLessThan(5.2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(!benchmarkEnabled)("30-second render benchmark", () => {
  it("measures a production-filter 30-second render", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clipforge-render-benchmark-"));
    const inputPath = join(workspace, "source.mp4");
    const assPath = join(workspace, "captions.ass");
    const outputPath = join(workspace, "rendered.mp4");

    try {
      await execFileAsync(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "30",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k",
        inputPath
      ]);
      const words = Array.from({ length: 12 }, (_, index) => ({
        text: index % 2 === 0 ? " नमस्ते" : " दुनिया।",
        start: index * 2 + 0.2,
        end: index * 2 + 1
      }));
      await writeFile(assPath, generateAssSubtitles(words, 0, 30));

      const command = buildFfmpegRenderCommand(inputPath, assPath, outputPath, 0, 30, "blur-fit");
      const startedAt = performance.now();
      await execFileAsync(ffmpegPath, command.args, { maxBuffer: 2 * 1024 * 1024 });
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      const { stdout } = await execFileAsync(ffprobePath, [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputPath
      ]);
      expect(Number(stdout.trim())).toBeGreaterThan(29.8);
      expect(Number(stdout.trim())).toBeLessThan(30.2);
      console.log(`Measured 30-second blur-fit render: ${elapsedSeconds.toFixed(2)} seconds (synthetic 640x360 input, Docker worker).`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);
});
