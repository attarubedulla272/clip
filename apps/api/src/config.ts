import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  MONGO_URI: z.string().min(1).default("mongodb://localhost:27017/clipforge"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.enum(["5m", "15m", "30m"]).default("15m"),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  COOKIE_SECURE: z.string().default("false").transform((value) => value === "true"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1_048_576).default(2_147_483_648),
  MAX_VIDEO_DURATION_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
  UPLOAD_CHUNK_BYTES: z.coerce.number().int().min(65_536).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  MIN_FREE_DISK_BYTES: z.coerce.number().int().min(0).default(268_435_456),
  WHISPER_MODEL_SIZE: z.enum(["tiny", "base", "small", "medium", "large-v3"]).default("base"),
  WHISPER_CHUNK_SECONDS: z.coerce.number().int().min(10).max(120).default(30),
  MAX_CONCURRENT_JOBS_PER_USER: z.coerce.number().int().min(1).max(10).default(1),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  YTDLP_PATH: z.string().min(1).default("/opt/yt-dlp-venv/bin/yt-dlp"),
  STORAGE_ROOT: z.string().min(1).default("./data")
});

const result = configSchema.safeParse(process.env);

if (!result.success) {
  throw new Error(`Invalid environment configuration: ${result.error.message}`);
}

export const config = {
  nodeEnv: result.data.NODE_ENV,
  port: result.data.API_PORT,
  webOrigin: result.data.WEB_ORIGIN,
  mongoUri: result.data.MONGO_URI,
  redisUrl: result.data.REDIS_URL,
  accessSecret: result.data.JWT_ACCESS_SECRET,
  refreshSecret: result.data.JWT_REFRESH_SECRET,
  accessTokenTtl: result.data.ACCESS_TOKEN_TTL,
  refreshTokenDays: result.data.REFRESH_TOKEN_DAYS,
  cookieSecure: result.data.COOKIE_SECURE || result.data.NODE_ENV === "production",
  maxUploadBytes: result.data.MAX_UPLOAD_BYTES,
  maxVideoDurationSeconds: result.data.MAX_VIDEO_DURATION_SECONDS,
  uploadChunkBytes: result.data.UPLOAD_CHUNK_BYTES,
  minFreeDiskBytes: result.data.MIN_FREE_DISK_BYTES,
  whisperModelSize: result.data.WHISPER_MODEL_SIZE,
  whisperChunkSeconds: result.data.WHISPER_CHUNK_SECONDS,
  maxConcurrentJobsPerUser: result.data.MAX_CONCURRENT_JOBS_PER_USER,
  ffmpegPath: result.data.FFMPEG_PATH,
  ffprobePath: result.data.FFPROBE_PATH,
  ytDlpPath: result.data.YTDLP_PATH,
  storageRoot: result.data.STORAGE_ROOT
} as const;
