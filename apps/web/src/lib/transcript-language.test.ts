import { describe, expect, it } from "vitest";
import { transcriptScriptMismatch } from "./transcript-language";

describe("transcriptScriptMismatch", () => {
  it("detects an English transcript stored with a Hindi language code", () => {
    expect(transcriptScriptMismatch("hi", "This is an English transcript with enough Latin script characters to be detected.")).toBe(true);
  });

  it("does not flag Hindi text matching the detected language", () => {
    expect(transcriptScriptMismatch("hi", "यह हिंदी में लिखा गया एक छोटा वाक्य है।")).toBe(false);
  });

  it("detects a Latin-script transcript stored with a Telugu language code", () => {
    expect(transcriptScriptMismatch("te", "This is an English transcript with enough Latin script characters to be detected.")).toBe(true);
  });

  it("does not report a mismatch for other languages or short text", () => {
    expect(transcriptScriptMismatch("en", "This transcript is English.")).toBe(false);
    expect(transcriptScriptMismatch("hi", "Hello.")).toBe(false);
  });
});
