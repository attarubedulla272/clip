import { describe, expect, it } from "vitest";
import { createProjectSchema, registerSchema } from "./index.js";

describe("shared request schemas", () => {
  it("normalizes registration email and requires a strong password", () => {
    expect(registerSchema.parse({ email: "  User@Example.com ", password: "a secure passphrase" })).toEqual({
      email: "user@example.com",
      password: "a secure passphrase"
    });
    expect(registerSchema.safeParse({ email: "user@example.com", password: "short" }).success).toBe(false);
  });

  it("trims and bounds project names", () => {
    expect(createProjectSchema.parse({ name: "  My clips " })).toEqual({ name: "My clips" });
    expect(createProjectSchema.safeParse({ name: " " }).success).toBe(false);
  });
});
