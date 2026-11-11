import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import bcrypt from "bcryptjs";
import { loginSchema, registerSchema } from "@clipforge/shared";
import { AppError } from "../errors.js";
import { User } from "../models/user.js";
import { validateBody } from "../middleware/validate.js";
import {
  clearAuthCookies,
  createAuthTokens,
  hashRefreshToken,
  requireAuth,
  setAuthCookies,
  verifyRefreshToken
} from "../middleware/auth.js";

const router = Router();
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many authentication attempts; try again later" }
});

router.post("/register", authRateLimit, validateBody(registerSchema), async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ email, passwordHash });
  const tokens = createAuthTokens(user.id, user.role);
  await User.updateOne(
    { _id: user._id },
    { $set: { refreshTokenHash: tokens.refreshTokenHash, refreshTokenExpiresAt: tokens.refreshExpiresAt } }
  );
  setAuthCookies(tokens, res);
  res.status(201).json({ user: { id: user.id, email: user.email, role: user.role } });
});

router.post("/login", authRateLimit, validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  const user = await User.findOne({ email }).select("+passwordHash");
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError(401, "Invalid email or password");
  }

  const tokens = createAuthTokens(user.id, user.role);
  await User.updateOne(
    { _id: user._id },
    { $set: { refreshTokenHash: tokens.refreshTokenHash, refreshTokenExpiresAt: tokens.refreshExpiresAt } }
  );
  setAuthCookies(tokens, res);
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

router.post("/refresh", async (req, res) => {
  const token: unknown = req.cookies?.clipforge_refresh;
  if (typeof token !== "string") {
    throw new AppError(401, "Refresh session expired; please log in again");
  }

  const claims = await verifyRefreshToken(token);
  const oldRefreshTokenHash = hashRefreshToken(token);
  const currentUser = await User.findOne({
    _id: claims.sub,
    refreshTokenHash: oldRefreshTokenHash,
    refreshTokenExpiresAt: { $gt: new Date() }
  });
  if (!currentUser) {
    throw new AppError(401, "Refresh session expired; please log in again");
  }

  const tokens = createAuthTokens(currentUser.id, currentUser.role);
  const user = await User.findOneAndUpdate(
    {
      _id: claims.sub,
      refreshTokenHash: oldRefreshTokenHash,
      refreshTokenExpiresAt: { $gt: new Date() }
    },
    {
      $set: {
        refreshTokenHash: tokens.refreshTokenHash,
        refreshTokenExpiresAt: tokens.refreshExpiresAt
      }
    },
    { new: true }
  );

  if (!user) {
    throw new AppError(401, "Refresh session expired; please log in again");
  }
  setAuthCookies(tokens, res);
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

router.post("/logout", async (req, res) => {
  const token: unknown = req.cookies?.clipforge_refresh;
  if (typeof token === "string") {
    await User.updateOne(
      { refreshTokenHash: hashRefreshToken(token) },
      { $unset: { refreshTokenHash: 1, refreshTokenExpiresAt: 1 } }
    );
  }
  clearAuthCookies(res);
  res.status(204).end();
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.auth?.userId).select("email role createdAt");
  if (!user) {
    throw new AppError(401, "Authentication required");
  }
  res.json({ user: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt } });
});

export default router;
