import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { nudgeClipEdge, parseTranscriptWords, snapToWordBoundary, type WordBoundary } from "@clipforge/shared/clip-trim";
import { clipMetadataResultSchema, validateMetadataRules } from "@clipforge/shared/clip-metadata";
import { CAPTION_STYLE_CONFIG, type CaptionStyle } from "@clipforge/shared/caption-config";
import { LocalDiskStorage } from "@clipforge/shared/storage";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { Clip } from "../models/clip.js";
import { Transcript } from "../models/transcript.js";
import { Video } from "../models/video.js";
import { ClipMetadata } from "../models/clip-metadata.js";
import { Job } from "../models/job.js";

const router = Router();
const clipParams = z.object({ clipId: z.string().regex(/^[a-f\d]{24}$/i) });
const updateClipSchema = z.object({
  start: z.number().finite().min(0).optional(),
  end: z.number().finite().min(0).optional(),
  nudge: z.object({
    edge: z.enum(["start", "end"]),
    direction: z.union([z.literal(-1), z.literal(1)])
  }).optional(),
  selectedForRendering: z.boolean().optional(),
  captionStyle: z.enum(Object.keys(CAPTION_STYLE_CONFIG) as [CaptionStyle, ...CaptionStyle[]]).optional(),
  cleanupCaptionFillers: z.boolean().optional()
}).strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one clip update")
  .refine((value) => !(value.nudge && (value.start !== undefined || value.end !== undefined)), "Use either a nudge or explicit trim values");
const updateMetadataSchema = z.object({
  result: clipMetadataResultSchema,
  language: z.enum(["same", "english"]),
  tone: z.enum(["curious", "direct", "informative"]),
  includeOriginalCredit: z.boolean(),
  useGemini: z.boolean()
}).strict();
const storage = new LocalDiskStorage(config.storageRoot);

router.use(requireAuth);

async function getOwnedClip(clipId: string, userId: string) {
  const clip = await Clip.findById(clipId);
  if (!clip) throw new AppError(404, "Clip not found");
  const video = await Video.findOne({ _id: clip.videoId, userId })
    .select("_id userId durationSeconds source sourceUrl sourceTitle originalName channel detectedType");
  if (!video) throw new AppError(404, "Clip not found");
  return { clip, video };
}

async function readWordBoundaries(videoId: Types.ObjectId, userId: string) {
  const transcript = await Transcript.findOne({ videoId }).select("wordsPath");
  if (!transcript) throw new AppError(409, "The word-level transcript is unavailable");

  let contents: string;
  try {
    contents = await readFile(storage.pathFor(userId, transcript.wordsPath), "utf8");
  } catch (error) {
    throw new AppError(500, "Could not read the saved word-level transcript", { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new AppError(500, "The saved word-level transcript is invalid JSON", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || !("words" in parsed) || !Array.isArray(parsed.words)) {
    throw new AppError(500, "The saved word-level transcript has an invalid format");
  }

  const parsedWords = parseTranscriptWords(parsed.words);
  if (parsedWords.skippedZeroDurationWords > 0) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "clips.trim.zero_duration_words.skipped",
      videoId: videoId.toString(),
      count: parsedWords.skippedZeroDurationWords
    }));
  }
  const words: Array<WordBoundary & { text: string }> = parsedWords.words;
  if (words.length === 0) throw new AppError(409, "The saved word-level transcript is empty");
  return words;
}

async function sendClipRender(
  clipId: string,
  userId: string,
  res: import("express").Response,
  download: boolean,
  preview = false
) {
  const { clip } = await getOwnedClip(clipId, userId);
  const filePath = preview ? clip.captionPreviewFilePath : clip.renderFilePath;
  if ((!preview && clip.renderStatus !== "ready") || !filePath) {
    throw new AppError(409, "This clip does not have a ready render");
  }
  const path = storage.pathFor(userId, filePath);
  let fileSize: number;
  try {
    fileSize = (await stat(path)).size;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new AppError(404, "The rendered clip file is missing");
    }
    throw error;
  }
  if (fileSize <= 0) throw new AppError(404, "The rendered clip file is empty");

  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": "video/mp4",
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="clip-${clip.id}${preview ? "-caption-preview" : ""}.mp4"`
  };
  const range = res.req.headers.range;
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
  const requestedEnd = match[1] && match[2] ? Number(match[2]) : fileSize - 1;
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
}

router.get("/:clipId/render/stream", validateParams(clipParams), async (req, res) => {
  const { clipId } = clipParams.parse(req.params);
  await sendClipRender(clipId, req.auth!.userId, res, false);
});

router.get("/:clipId/render/download", validateParams(clipParams), async (req, res) => {
  const { clipId } = clipParams.parse(req.params);
  await sendClipRender(clipId, req.auth!.userId, res, true);
});

router.get("/:clipId/render/preview", validateParams(clipParams), async (req, res) => {
  const { clipId } = clipParams.parse(req.params);
  await sendClipRender(clipId, req.auth!.userId, res, false, true);
});

router.patch("/:clipId/metadata", validateParams(clipParams), validateBody(updateMetadataSchema), async (req, res) => {
  const clipId = clipParams.parse(req.params).clipId;
  const { clip, video } = await getOwnedClip(clipId, req.auth!.userId);
  const metadata = await ClipMetadata.findOne({ clipId: clip._id, videoId: video._id });
  if (!metadata?.result) throw new AppError(409, "Generate metadata before editing it");
  if (["queued", "processing", "retrying"].includes(metadata.generationStatus)) {
    throw new AppError(409, "Wait for metadata generation to finish before editing");
  }
  const updates = updateMetadataSchema.parse(req.body);
  const includeOriginalCredit = video.source === "url" && updates.includeOriginalCredit;
  const creditLine = includeOriginalCredit && video.sourceUrl
    ? `Original video: ${video.channel ? `${video.channel} · ` : ""}${video.sourceUrl}`
    : undefined;
  const descriptionWithoutCredit = updates.result.youtube.description
    .split(/\r?\n/)
    .filter((line) => !/^Original video:/i.test(line.trim()))
    .join("\n")
    .trimEnd();
  const result = clipMetadataResultSchema.parse({
    ...updates.result,
    youtube: {
      ...updates.result.youtube,
      description: creditLine ? `${descriptionWithoutCredit}\n${creditLine}` : descriptionWithoutCredit
    }
  });
  const checked = validateMetadataRules(result, clip.transcriptText, {
    sourceTitle: video.sourceTitle ?? video.originalName,
    videoType: video.detectedType ?? "other",
    ...(creditLine ? { creditLine } : {})
  });
  if (!checked.success) {
    throw new AppError(422, `Metadata does not meet the content rules: ${checked.errors.join("; ")}`);
  }
  metadata.result = checked.data;
  metadata.warnings = checked.warnings.reduce<Record<string, string[]>>((grouped, issue) => {
    (grouped[issue.field] ??= []).push(issue.message);
    return grouped;
  }, {});
  metadata.language = updates.language;
  metadata.tone = updates.tone;
  metadata.includeOriginalCredit = includeOriginalCredit;
  metadata.useGemini = updates.useGemini;
  metadata.edited = true;
  await metadata.save();
  res.json({ metadata: metadata.toObject() });
});

router.delete("/:clipId/render", validateParams(clipParams), async (req, res) => {
  const { clip, video } = await getOwnedClip(clipParams.parse(req.params).clipId, req.auth!.userId);
  if (clip.renderStatus === "rendering") throw new AppError(409, "Wait for the render job to finish before deleting it");
  if (clip.renderFilePath) await storage.delete(video.userId.toString(), clip.renderFilePath);
  if (clip.captionPreviewFilePath) await storage.delete(video.userId.toString(), clip.captionPreviewFilePath);
  await Clip.updateOne({ _id: clip._id }, {
    $set: { renderStatus: "not-rendered", renderProgress: { message: "Not rendered", percent: 0 } },
    $unset: { renderFilePath: 1, captionPreviewFilePath: 1, renderSettings: 1, renderedAt: 1, renderError: 1, renderJobId: 1, renderQueueJobId: 1 }
  });
  res.status(204).end();
});

router.patch("/:clipId", validateParams(clipParams), validateBody(updateClipSchema), async (req, res) => {
  const clipId = clipParams.parse(req.params).clipId;
  const { clip, video } = await getOwnedClip(clipId, req.auth!.userId);
  const updates = req.body as z.infer<typeof updateClipSchema>;
  const fields: {
    start?: number;
    end?: number;
    transcriptText?: string;
    selectedForRendering?: boolean;
    captionStyle?: CaptionStyle;
    cleanupCaptionFillers?: boolean;
    renderStatus?: "not-rendered";
    renderProgress?: { message: string; percent: number };
  } = {};
  const unsetFields: Record<string, 1> = {};

  if (updates.selectedForRendering === false && clip.renderStatus === "rendering") {
    throw new AppError(409, "Wait for the render job to finish before deselecting this clip");
  }

  const captionSettingsChanged =
    (updates.captionStyle !== undefined && updates.captionStyle !== clip.captionStyle) ||
    (updates.cleanupCaptionFillers !== undefined && updates.cleanupCaptionFillers !== clip.cleanupCaptionFillers);
  if (captionSettingsChanged || updates.start !== undefined || updates.end !== undefined || updates.nudge) {
    const activePreview = await Job.findOne({
      clipId: clip._id,
      userId: req.auth!.userId,
      type: "render",
      captionPreview: true,
      status: { $in: ["queued", "processing", "retrying"] }
    }).select("_id");
    if (activePreview) throw new AppError(409, "Wait for the caption preview to finish before changing clip or caption settings");
  }
  if ((updates.captionStyle !== undefined || updates.cleanupCaptionFillers !== undefined) &&
    clip.renderStatus === "rendering") {
    throw new AppError(409, "Wait for the current render to finish before changing caption settings");
  }
  if (updates.captionStyle !== undefined) fields.captionStyle = updates.captionStyle;
  if (updates.cleanupCaptionFillers !== undefined) fields.cleanupCaptionFillers = updates.cleanupCaptionFillers;
  if (updates.start !== undefined || updates.end !== undefined || updates.nudge) {
    if (clip.renderStatus === "rendering") {
      throw new AppError(409, "Wait for the current render to finish before changing the trim");
    }
    const words = await readWordBoundaries(clip.videoId, req.auth!.userId);
    if (updates.nudge) {
      if (typeof video.durationSeconds !== "number" || video.durationSeconds <= 0) {
        throw new AppError(409, "The source video duration is unavailable");
      }
      let nudged: { start: number; end: number };
      try {
        nudged = nudgeClipEdge(
          clip.start,
          clip.end,
          updates.nudge.edge,
          updates.nudge.direction,
          video.durationSeconds,
          words
        );
      } catch (error) {
        if (error instanceof RangeError) throw new AppError(422, error.message);
        throw error;
      }
      clip.start = nudged.start;
      clip.end = nudged.end;
    } else {
      if (updates.start !== undefined) {
        clip.start = snapToWordBoundary(updates.start, words, "start");
      }
      if (updates.end !== undefined) {
        clip.end = snapToWordBoundary(updates.end, words, "end");
      }
    }
    const durationSeconds = video.durationSeconds;
    if (clip.start >= clip.end || (typeof durationSeconds === "number" && clip.end > durationSeconds)) {
      throw new AppError(422, "The trim must stay within the video and keep a positive duration");
    }
    clip.transcriptText = words
      .filter((word) => word.start >= clip.start && word.end <= clip.end)
      .map((word) => word.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    fields.start = clip.start;
    fields.end = clip.end;
    fields.transcriptText = clip.transcriptText;
    fields.renderStatus = "not-rendered";
    fields.renderProgress = { message: "Trim changed; render again", percent: 0 };
    for (const key of ["renderFilePath", "renderSettings", "renderedAt", "renderError", "renderJobId", "renderQueueJobId", "captionPreviewFilePath"]) {
      unsetFields[key] = 1;
    }
    if (clip.renderFilePath) await storage.delete(video.userId.toString(), clip.renderFilePath);
    if (clip.captionPreviewFilePath) await storage.delete(video.userId.toString(), clip.captionPreviewFilePath);
  }
  if (updates.selectedForRendering !== undefined) {
    fields.selectedForRendering = updates.selectedForRendering;
  }
  if (captionSettingsChanged) {
    fields.renderStatus = "not-rendered";
    fields.renderProgress = { message: "Caption settings changed; render again", percent: 0 };
    for (const key of ["renderFilePath", "renderSettings", "renderedAt", "renderError", "renderJobId", "renderQueueJobId", "captionPreviewFilePath"]) {
      unsetFields[key] = 1;
    }
    if (clip.renderFilePath) await storage.delete(video.userId.toString(), clip.renderFilePath);
    if (clip.captionPreviewFilePath) await storage.delete(video.userId.toString(), clip.captionPreviewFilePath);
  }
  const updatedClip = await Clip.findByIdAndUpdate(
    clip._id,
    { $set: fields, ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {}) },
    { new: true }
  ).lean();
  if (!updatedClip) throw new AppError(404, "Clip not found");
  res.json({ clip: updatedClip });
});

router.delete("/:clipId", validateParams(clipParams), async (req, res) => {
  const clipId = clipParams.parse(req.params).clipId;
  const { clip, video } = await getOwnedClip(clipId, req.auth!.userId);
  if (clip.renderStatus === "rendering") {
    throw new AppError(409, "Wait for the render job to finish before discarding this clip");
  }
  if (clip.renderFilePath) await storage.delete(video.userId.toString(), clip.renderFilePath);
  if (clip.captionPreviewFilePath) await storage.delete(video.userId.toString(), clip.captionPreviewFilePath);
  await clip.deleteOne();
  res.status(204).end();
});

export default router;
