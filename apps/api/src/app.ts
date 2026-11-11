import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import mongoose from "mongoose";
import multer from "multer";
import { AppError } from "./errors.js";
import { config } from "./config.js";
import { shouldSkipApiRateLimit } from "./middleware/api-rate-limit.js";
import authRouter from "./routes/auth.js";
import projectsRouter from "./routes/projects.js";
import jobsRouter from "./routes/jobs.js";
import uploadsRouter from "./routes/uploads.js";
import urlImportRouter from "./routes/url-import.js";
import clipsRouter from "./routes/clips.js";
import videoStreamRouter from "./routes/video-stream.js";
import { MediaProbeError } from "@clipforge/shared/media-probe";

export const app = express();
const API_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

app.disable("x-powered-by");
app.use(helmet());
if (config.nodeEnv !== "production") {
  app.use((_req, res, next) => {
    res.removeHeader("Strict-Transport-Security");
    next();
  });
}
app.use(cors({
  origin: config.webOrigin,
  credentials: true,
  exposedHeaders: ["Upload-Offset", "Upload-Length", "Upload-Chunk-Size", "Upload-Expires", "Retry-After"]
}));
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  const requestId = randomUUID();
  res.setHeader("x-request-id", requestId);
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(JSON.stringify({
      level: "info",
      event: "http.request",
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    }));
  });
  next();
});
app.use(
  "/api",
  rateLimit({
    windowMs: API_RATE_LIMIT_WINDOW_MS,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => shouldSkipApiRateLimit(req.method),
    handler: (_req, res) => {
      const retryAfterSeconds = Math.ceil(API_RATE_LIMIT_WINDOW_MS / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Too many state-changing requests. Please wait before trying again.",
        retryAfterSeconds
      });
    }
  })
);

app.get("/health", (_req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  res.status(mongoReady ? 200 : 503).json({
    status: mongoReady ? "ok" : "not_ready",
    services: { mongo: mongoReady ? "connected" : "disconnected" }
  });
});

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/projects", projectsRouter);
app.use("/api/v1/projects", urlImportRouter);
app.use("/api/v1/uploads", uploadsRouter);
app.use("/api/v1/clips", clipsRouter);
app.use("/api/v1", videoStreamRouter);
app.use("/api/v1", jobsRouter);
app.use("/api/v1", (_req, _res, next) => next(new AppError(404, "API route not found")));
app.use((_req, _res, next) => next(new AppError(404, "Route not found")));

const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  let statusCode = 500;
  let message = "Internal server error";

  if (error instanceof AppError) {
    statusCode = error.statusCode;
    message = error.message;
  } else if (error instanceof MediaProbeError) {
    statusCode = error.statusCode;
    message = error.message;
  } else if (error instanceof multer.MulterError) {
    statusCode = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    message = error.code === "LIMIT_FILE_SIZE" ? "Video exceeds the configured upload size limit" : error.message;
  } else if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
    statusCode = 400;
    message = error.message;
  } else if (error instanceof SyntaxError && "body" in error) {
    statusCode = 400;
    message = "Invalid JSON request body";
  } else if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
    statusCode = 413;
    message = "Request body is too large";
  } else if (error && typeof error === "object" && "code" in error && error.code === 11000) {
    statusCode = 409;
    message = "An account with that email already exists";
  }

  console.error(JSON.stringify({
    level: statusCode >= 500 ? "error" : "warn",
    event: "http.error",
    requestId: res.getHeader("x-request-id"),
    method: req.method,
    path: req.path,
    statusCode,
    message: statusCode >= 500 ? "Internal server error" : message
  }));
  res.status(statusCode).json({ error: message, requestId: res.getHeader("x-request-id") });
};

app.use(errorHandler);
