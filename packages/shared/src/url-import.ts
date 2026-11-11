import { z } from "zod";

const videoIdPattern = /^[a-zA-Z0-9_-]{11}$/;
const allowedHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

export const urlImportMetadataSchema = z.object({
  id: z.string().regex(videoIdPattern),
  title: z.string().min(1).max(500),
  channel: z.string().min(1).max(200),
  durationSeconds: z.number().finite().positive(),
  thumbnailUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "ytimg.com" || url.hostname.endsWith(".ytimg.com") ||
        url.hostname === "ggpht.com" || url.hostname.endsWith(".ggpht.com"));
  }),
  estimatedSizeBytes: z.number().int().positive()
});

export type UrlImportMetadata = z.infer<typeof urlImportMetadataSchema>;

export function validateYouTubeUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid YouTube video link.");
  }
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase()) ||
    url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("Only HTTPS YouTube video links are supported.");
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  const videoId = url.hostname === "youtu.be"
    ? pathParts.length === 1 ? pathParts[0] : undefined
    : url.pathname === "/watch"
      ? url.searchParams.get("v")
      : pathParts.length === 2 && ["shorts", "live", "embed", "v"].includes(pathParts[0] ?? "")
        ? pathParts[1]
        : undefined;
  if (!videoId || !videoIdPattern.test(videoId)) {
    throw new Error("Enter a link to a single YouTube video, not a playlist or channel.");
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

interface YtDlpMetadata {
  id?: unknown;
  title?: unknown;
  channel?: unknown;
  channel_name?: unknown;
  uploader?: unknown;
  duration?: unknown;
  thumbnail?: unknown;
  thumbnails?: unknown;
  filesize?: unknown;
  filesize_approx?: unknown;
  requested_formats?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSize(value: unknown) {
  return isRecord(value)
    ? validSize(value.filesize) ?? validSize(value.filesize_approx)
    : undefined;
}

function validSize(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseYtDlpMetadata(input: unknown): UrlImportMetadata {
  if (!isRecord(input)) throw new Error("YouTube returned invalid video metadata.");
  const raw = input as YtDlpMetadata;
  const requestedFormats = Array.isArray(raw.requested_formats) ? raw.requested_formats : [];
  const componentSizes = requestedFormats.map(formatSize);
  const estimatedSizeBytes = componentSizes.length > 0 && componentSizes.every((size) => size !== undefined)
    ? componentSizes.reduce<number>((total, size) => total + size!, 0)
    : validSize(raw.filesize) ?? validSize(raw.filesize_approx);
  const thumbnails = Array.isArray(raw.thumbnails) ? raw.thumbnails : [];
  const lastThumbnail = thumbnails.filter(isRecord).at(-1)?.url;
  const metadata = {
    id: raw.id,
    title: raw.title,
    channel: raw.channel ?? raw.channel_name ?? raw.uploader,
    durationSeconds: raw.duration,
    thumbnailUrl: raw.thumbnail ?? lastThumbnail,
    estimatedSizeBytes
  };
  const parsed = urlImportMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    throw new Error(estimatedSizeBytes === undefined
      ? "Could not estimate this video's download size before importing. Please upload the video file instead."
      : "YouTube returned incomplete or invalid video metadata.");
  }
  return parsed.data;
}

export function enforceUrlImportLimits(metadata: Pick<UrlImportMetadata, "durationSeconds" | "estimatedSizeBytes">, maxDurationSeconds: number, maxSizeBytes: number) {
  if (metadata.durationSeconds > maxDurationSeconds) {
    throw new Error(`Video duration (${Math.ceil(metadata.durationSeconds)} seconds) exceeds the configured ${maxDurationSeconds}-second limit.`);
  }
  if (metadata.estimatedSizeBytes > maxSizeBytes) {
    throw new Error(`Estimated video size (${metadata.estimatedSizeBytes} bytes) exceeds the configured ${maxSizeBytes}-byte upload limit.`);
  }
}

export function mapYtDlpError(output: string) {
  const message = output.toLowerCase();
  const uploadFallback = " Please upload the video file instead.";
  if (/private video|video is private|private video cannot/.test(message)) {
    return `This video is private and cannot be imported. Check its availability or permission.${uploadFallback}`;
  }
  if (/age.?restricted|confirm your age|sign in to confirm your age/.test(message)) {
    return `This video is age-restricted and cannot be imported. ClipForge does not bypass this restriction.${uploadFallback}`;
  }
  if (/geo.?restrict|not available in your country|blocked in your country/.test(message)) {
    return `This video is geo-blocked and cannot be imported. ClipForge does not bypass this restriction.${uploadFallback}`;
  }
  if (/video unavailable|video is unavailable|has been removed|video has been removed|does not exist/.test(message)) {
    return `This video was removed or is unavailable.${uploadFallback}`;
  }
  if (/bot|automated queries|not a bot|unusual traffic/.test(message)) {
    return `YouTube blocked this request with a bot check. ClipForge does not bypass bot checks.${uploadFallback}`;
  }
  return `Could not import this video. Check that the link works, or upload the video file instead.`;
}
