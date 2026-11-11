import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Router } from "express";
import { z } from "zod";
import { LocalDiskStorage } from "@clipforge/shared/storage";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { validateParams } from "../middleware/validate.js";
import { Video } from "../models/video.js";

const router = Router();
const videoParams = z.object({ videoId: z.string().regex(/^[a-f\d]{24}$/i) });
const storage = new LocalDiskStorage(config.storageRoot);
const mimeTypes: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm"
};

router.use(requireAuth);

router.get("/videos/:videoId/stream", validateParams(videoParams), async (req, res) => {
  const video = await Video.findOne({ _id: req.params.videoId, userId: req.auth!.userId })
    .select("storageKey originalName hasVideo");
  if (!video) throw new AppError(404, "Video not found");
  if (!video.hasVideo) throw new AppError(422, "This media file has no video stream");

  const path = storage.pathFor(req.auth!.userId, video.storageKey);
  let fileSize: number;
  try {
    fileSize = (await stat(path)).size;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new AppError(404, "The source video file is missing");
    }
    throw error;
  }
  if (fileSize <= 0) throw new AppError(404, "The source video file is empty");

  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": mimeTypes[extname(video.originalName).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff"
  };
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { ...headers, "Content-Length": fileSize });
    createReadStream(path).on("error", (error) => res.destroy(error)).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${fileSize}` }).end();
    return;
  }
  const suffixLength = match[1] ? undefined : Number(match[2]);
  const start = match[1] ? Number(match[1]) : Math.max(0, fileSize - (suffixLength ?? 0));
  const requestedEnd = match[2] && match[1] ? Number(match[2]) : fileSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
    (suffixLength !== undefined && (!Number.isSafeInteger(suffixLength) || suffixLength <= 0)) ||
    start >= fileSize || requestedEnd < start) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${fileSize}` }).end();
    return;
  }

  const end = Math.min(requestedEnd, fileSize - 1);
  res.writeHead(206, {
    ...headers,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${fileSize}`
  });
  createReadStream(path, { start, end }).on("error", (error) => res.destroy(error)).pipe(res);
});

export default router;
