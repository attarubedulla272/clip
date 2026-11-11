import { createWriteStream } from "node:fs";
import { truncate } from "node:fs/promises";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function writeUploadChunk(
  filePath: string,
  input: Readable,
  offset: number,
  contentLength: number,
  maxChunkBytes: number
) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Upload offset must be a non-negative integer");
  if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maxChunkBytes) {
    throw new Error(`Chunk size must be between 1 and ${maxChunkBytes} bytes`);
  }

  let received = 0;
  const byteLimit = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      received += chunk.length;
      if (received > contentLength) {
        callback(new Error("Chunk body exceeded its declared Content-Length"));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      input,
      byteLimit,
      createWriteStream(filePath, { flags: "r+", start: offset })
    );
    if (received !== contentLength) {
      throw new Error(`Chunk body ended early: expected ${contentLength} bytes, received ${received}`);
    }
    return received;
  } catch (error) {
    await truncate(filePath, offset);
    throw error;
  }
}
