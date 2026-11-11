import { createHash, randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { userRoleSchema } from "@clipforge/shared";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { User } from "../models/user.js";

const ACCESS_COOKIE = "clipforge_access";
const REFRESH_COOKIE = "clipforge_refresh";

interface AccessClaims {
  sub: string;
  role: "user" | "admin";
}

interface RefreshClaims {
  sub: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenCookieOptions(maxAge: number, path: string) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax" as const,
    path,
    maxAge
  };
}

export function createAuthTokens(userId: string, role: "user" | "admin"): AuthTokens {
  const accessToken = jwt.sign({ role }, config.accessSecret, {
    subject: userId,
    expiresIn: config.accessTokenTtl
  });
  const refreshToken = jwt.sign({}, config.refreshSecret, {
    subject: userId,
    expiresIn: `${config.refreshTokenDays}d`,
    jwtid: randomUUID()
  });
  const refreshExpiresAt = new Date(Date.now() + config.refreshTokenDays * 24 * 60 * 60 * 1000);

  return {
    accessToken,
    refreshToken,
    refreshTokenHash: hashToken(refreshToken),
    refreshExpiresAt
  };
}

export function setAuthCookies(tokens: AuthTokens, res: Parameters<RequestHandler>[1]) {
  const accessTokenMaxAge = { "5m": 5, "15m": 15, "30m": 30 }[config.accessTokenTtl] * 60 * 1000;
  res.cookie(ACCESS_COOKIE, tokens.accessToken, tokenCookieOptions(accessTokenMaxAge, "/"));
  res.cookie(
    REFRESH_COOKIE,
    tokens.refreshToken,
    tokenCookieOptions(config.refreshTokenDays * 24 * 60 * 60 * 1000, "/api/v1/auth")
  );
}

export function clearAuthCookies(res: Parameters<RequestHandler>[1]) {
  res.clearCookie(ACCESS_COOKIE, tokenCookieOptions(0, "/"));
  res.clearCookie(REFRESH_COOKIE, tokenCookieOptions(0, "/api/v1/auth"));
}

export function hashRefreshToken(token: string) {
  return hashToken(token);
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token: unknown = req.cookies?.[ACCESS_COOKIE];
  if (typeof token !== "string") {
    next(new AppError(401, "Authentication required"));
    return;
  }

  try {
    const decoded = jwt.verify(token, config.accessSecret);
    if (typeof decoded === "string" || typeof decoded.sub !== "string") {
      throw new AppError(401, "Invalid access token");
    }
    const role = userRoleSchema.safeParse(decoded.role);
    if (!role.success) {
      throw new AppError(401, "Invalid access token");
    }
    req.auth = { userId: decoded.sub, role: role.data };
    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      next(new AppError(401, "Authentication required"));
      return;
    }
    next(error);
  }
};

export function requireRole(...roles: Array<"user" | "admin">): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      next(new AppError(403, "Insufficient permissions"));
      return;
    }
    next();
  };
}

export async function verifyRefreshToken(token: string): Promise<RefreshClaims> {
  try {
    const decoded = jwt.verify(token, config.refreshSecret);
    if (typeof decoded === "string" || typeof decoded.sub !== "string") {
      throw new AppError(401, "Invalid refresh token");
    }
    return { sub: decoded.sub };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      throw new AppError(401, "Refresh session expired; please log in again");
    }
    throw error;
  }
}
