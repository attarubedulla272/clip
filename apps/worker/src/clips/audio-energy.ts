import { spawn } from "node:child_process";

const SAMPLE_RATE = 8_000;

export function measureAudioEnergyBySecond(ffmpegPath: string, mediaPath: string): Promise<number[]> {
  const child = spawn(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", mediaPath,
    "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE),
    "-f", "s16le", "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const energy: number[] = [];
  let sumSquares = 0;
  let sampleCount = 0;
  let pendingByte: number | undefined;
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    let offset = 0;
    if (pendingByte !== undefined && chunk.length > 0) {
      const unsignedSample = pendingByte | (chunk[0]! << 8);
      const sample = unsignedSample >= 32_768 ? unsignedSample - 65_536 : unsignedSample;
      sumSquares += sample * sample;
      sampleCount += 1;
      offset = 1;
      pendingByte = undefined;
      if (sampleCount === SAMPLE_RATE) {
        energy.push(Math.sqrt(sumSquares / sampleCount) / 32_768);
        sumSquares = 0;
        sampleCount = 0;
      }
    }
    while (offset + 1 < chunk.length) {
      const sample = chunk.readInt16LE(offset);
      sumSquares += sample * sample;
      sampleCount += 1;
      offset += 2;
      if (sampleCount === SAMPLE_RATE) {
        energy.push(Math.sqrt(sumSquares / sampleCount) / 32_768);
        sumSquares = 0;
        sampleCount = 0;
      }
    }
    if (offset < chunk.length) pendingByte = chunk[offset];
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });

  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`Could not start ffmpeg audio analysis: ${error.message}`, { cause: error })));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg audio analysis failed${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`));
        return;
      }
      if (sampleCount > 0) energy.push(Math.sqrt(sumSquares / sampleCount) / 32_768);
      resolve(energy);
    });
  });
}
