import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Router } from "express";
import { writeUploadChunk } from "@clipforge/shared/chunk-upload";
import { enforceDurationLimit, probeMediaFile } from "@clipforge/shared/media-probe";
import { LocalDiskStorage } from "@clipforge/shared/storage";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { UploadSession } from "../models/upload-session.js";
import { Video } from "../models/video.js";
import { validateParams } from "../middleware/validate.js";
import { z } from "zod";

const router = Router();
const storage = new LocalDiskStorage(config.storageRoot);
const paramsSchema = z.object({ uploadId: z.string().uuid() });
const activeUploads = new Set<string>();

router.use(requireAuth);

function getUploadId(value: string | string[] | undefined) {
  if (typeof value !== "string") throw new AppError(400, "Invalid upload ID");
  return value;
}

async function getOwnedSession(uploadId: string, userId: string) {
  const session = await UploadSession.findOne({ _id: uploadId, userId, status: "uploading" });
  if (!session) throw new AppError(404, "Upload session not found or expired");
  return session;
}

router.head("/:uploadId", validateParams(paramsSchema), async (req, res) => {
  const session = await getOwnedSession(getUploadId(req.params.uploadId), req.auth!.userId);
  res.setHeader("Upload-Offset", String(session.offsetBytes));
  res.setHeader("Upload-Length", String(session.expectedSizeBytes));
  res.setHeader("Upload-Chunk-Size", String(config.uploadChunkBytes));
  res.setHeader("Upload-Expires", session.expiresAt.toISOString());
  res.status(204).end();
});

router.put("/:uploadId", validateParams(paramsSchema), async (req, res) => {
  const uploadId = getUploadId(req.params.uploadId);
  const session = await getOwnedSession(uploadId, req.auth!.userId);
  const offsetHeader = req.headers["upload-offset"];
  const lengthHeader = req.headers["content-length"];
  const offset = typeof offsetHeader === "string" ? Number(offsetHeader) : Number.NaN;
  const contentLength = typeof lengthHeader === "string" ? Number(lengthHeader) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset !== session.offsetBytes) {
    res.setHeader("Upload-Offset", String(session.offsetBytes));
    throw new AppError(409, "Upload offset does not match; query the current offset and resume from there");
  }
  const remainingBytes = session.expectedSizeBytes - session.offsetBytes;
  if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > config.uploadChunkBytes || contentLength > remainingBytes) {
    throw new AppError(413, `Chunk must be between 1 and ${Math.min(config.uploadChunkBytes, remainingBytes)} bytes`);
  }
  if (req.headers["content-type"] !== "application/offset+octet-stream") {
    throw new AppError(415, "Chunk Content-Type must be application/offset+octet-stream");
  }
  if (activeUploads.has(uploadId)) throw new AppError(409, "Another chunk is already being written for this upload");
  activeUploads.add(uploadId);

  try {
    const bytesWritten = await writeUploadChunk(
      storage.pathFor(req.auth!.userId, session.storageKey),
      req,
      offset,
      contentLength,
      config.uploadChunkBytes
    );
    const nextOffset = offset + bytesWritten;
    const updated = await UploadSession.findOneAndUpdate(
      { _id: uploadId, userId: req.auth!.userId, status: "uploading", offsetBytes: offset },
      { $set: { offsetBytes: nextOffset, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } },
      { new: true }
    );
    if (!updated) throw new AppError(409, "Upload session changed while the chunk was being written");
    res.setHeader("Upload-Offset", String(nextOffset));
    res.status(204).end();
  } catch (error) {
    if (req.destroyed || req.aborted) {
      console.warn(JSON.stringify({
        level: "warn",
        event: "upload.chunk.disconnected",
        uploadId,
        offsetBytes: offset,
        message: error instanceof Error ? error.message : "Client disconnected"
      }));
      return;
    }
    throw error;
  } finally {
    activeUploads.delete(uploadId);
  }
});

router.post("/:uploadId/complete", validateParams(paramsSchema), async (req, res) => {
  const session = await getOwnedSession(getUploadId(req.params.uploadId), req.auth!.userId);
  if (session.offsetBytes !== session.expectedSizeBytes) {
    throw new AppError(409, `Upload is incomplete: ${session.offsetBytes} of ${session.expectedSizeBytes} bytes received`);
  }
  const sourcePath = storage.pathFor(session.userId.toString(), session.storageKey);
  const file = await stat(sourcePath);
  if (file.size !== session.expectedSizeBytes) {
    throw new AppError(409, "Uploaded file size does not match the declared size; resume the upload or cancel it");
  }

  const media = await probeMediaFile(sourcePath, config.ffprobePath);
  enforceDurationLimit(media.durationSeconds, config.maxVideoDurationSeconds);
  const extension = extname(session.originalName).toLowerCase();
  const videoKey = `videos/${session._id}${extension}`;
  await storage.move(session.userId.toString(), session.storageKey, videoKey);
  try {
    const video = await Video.create({
      userId: session.userId,
      projectId: session.projectId,
      source: "upload",
      originalName: session.originalName,
      storageKey: videoKey,
      sizeBytes: session.expectedSizeBytes,
      durationSeconds: media.durationSeconds,
      hasAudio: media.hasAudio,
      hasVideo: media.hasVideo
    });
    await UploadSession.deleteOne({ _id: session._id, userId: session.userId });
    res.status(201).json({
      video: {
        _id: video.id,
        projectId: video.projectId,
        originalName: video.originalName,
        sizeBytes: video.sizeBytes,
        durationSeconds: video.durationSeconds,
        status: video.status,
        createdAt: video.createdAt
      }
    });
  } catch (error) {
    await storage.move(session.userId.toString(), videoKey, session.storageKey);
    throw error;
  }
});

router.delete("/:uploadId", validateParams(paramsSchema), async (req, res) => {
  const uploadId = getUploadId(req.params.uploadId);
  if (activeUploads.has(uploadId)) throw new AppError(409, "A chunk is still being written; cancel again once it stops");
  const session = await getOwnedSession(uploadId, req.auth!.userId);
  await UploadSession.deleteOne({ _id: uploadId, userId: req.auth!.userId });
  await storage.delete(req.auth!.userId, session.storageKey);
  res.status(204).end();
});

export default router;
