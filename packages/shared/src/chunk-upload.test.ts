import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { writeUploadChunk } from "./chunk-upload.js";

describe("writeUploadChunk", () => {
  it("resumes at the acknowledged offset after an interrupted chunk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clipforge-resume-"));
    const filePath = join(directory, "upload.part");
    try {
      await pipeline(Readable.from([]), createWriteStream(filePath));
      await writeUploadChunk(filePath, Readable.from([Buffer.from("hello")]), 0, 5, 1024);

      const interrupted = new PassThrough();
      const failedWrite = writeUploadChunk(filePath, interrupted, 5, 6, 1024);
      interrupted.write("bad");
      interrupted.destroy(new Error("client disconnected"));
      await expect(failedWrite).rejects.toThrow("client disconnected");
      expect(await readFile(filePath, "utf8")).toBe("hello");

      await writeUploadChunk(filePath, Readable.from([Buffer.from(" world")]), 5, 6, 1024);
      expect(await readFile(filePath, "utf8")).toBe("hello world");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
