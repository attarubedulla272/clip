import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "../errors.js";

export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new AppError(400, result.error.issues.map((issue) => issue.message).join(", ")));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateParams<T extends Record<string, string>>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      next(new AppError(400, result.error.issues.map((issue) => issue.message).join(", ")));
      return;
    }
    req.params = result.data;
    next();
  };
}
