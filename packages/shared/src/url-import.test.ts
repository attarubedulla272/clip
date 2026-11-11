import { describe, expect, it } from "vitest";
import {
  enforceUrlImportLimits,
  mapYtDlpError,
  parseYtDlpMetadata,
  validateYouTubeUrl
} from "./url-import.js";

describe("validateYouTubeUrl", () => {
  it("accepts supported YouTube video URLs and canonicalizes them", () => {
    expect(validateYouTubeUrl("https://youtu.be/AbCdEf12345?t=10"))
      .toBe("https://www.youtube.com/watch?v=AbCdEf12345");
    expect(validateYouTubeUrl("https://www.youtube.com/watch?v=AbCdEf12345&list=PL123"))
      .toBe("https://www.youtube.com/watch?v=AbCdEf12345");
  });

  it("rejects non-YouTube, insecure, and playlist-only URLs", () => {
    expect(() => validateYouTubeUrl("http://youtube.com/watch?v=AbCdEf12345")).toThrow(/HTTPS/);
    expect(() => validateYouTubeUrl("https://example.com/watch?v=AbCdEf12345")).toThrow(/HTTPS YouTube/);
    expect(() => validateYouTubeUrl("https://youtube.com/playlist?list=PL123")).toThrow(/single YouTube video/);
    expect(() => validateYouTubeUrl("https://youtube.com/channel/AbCdEf12345")).toThrow(/single YouTube video/);
  });
});

describe("parseYtDlpMetadata", () => {
  it("parses title, channel, duration, thumbnail, and merged format sizes", () => {
    expect(parseYtDlpMetadata({
      id: "AbCdEf12345",
      title: "An owned video",
      channel: "Example Channel",
      duration: 123,
      thumbnail: "https://i.ytimg.com/vi/AbCdEf12345/hqdefault.jpg",
      requested_formats: [{ filesize: 400 }, { filesize_approx: 600 }]
    })).toEqual({
      id: "AbCdEf12345",
      title: "An owned video",
      channel: "Example Channel",
      durationSeconds: 123,
      thumbnailUrl: "https://i.ytimg.com/vi/AbCdEf12345/hqdefault.jpg",
      estimatedSizeBytes: 1000
    });
  });

  it("rejects metadata without a safe pre-download size estimate", () => {
    expect(() => parseYtDlpMetadata({
      id: "AbCdEf12345",
      title: "Unknown size",
      uploader: "Channel",
      duration: 123,
      thumbnail: "https://example.com/thumb.jpg"
    })).toThrow(/estimate.*size/i);
  });
});

describe("enforceUrlImportLimits", () => {
  it("allows a 68-minute source when the configured cap is 90 minutes", () => {
    expect(() => enforceUrlImportLimits({ durationSeconds: 4_080, estimatedSizeBytes: 10 }, 5_400, 100))
      .not.toThrow();
  });

  it("rejects over-duration and over-size sources before download", () => {
    expect(() => enforceUrlImportLimits({ durationSeconds: 61, estimatedSizeBytes: 10 }, 60, 100))
      .toThrow(/duration/);
    expect(() => enforceUrlImportLimits({ durationSeconds: 5_401, estimatedSizeBytes: 10 }, 5_400, 100))
      .toThrow(/duration/);
    expect(() => enforceUrlImportLimits({ durationSeconds: 60, estimatedSizeBytes: 101 }, 60, 100))
      .toThrow(/size/);
  });
});

describe("mapYtDlpError", () => {
  it.each([
    ["Private video", /private.*upload/i],
    ["Sign in to confirm your age", /age-restricted.*does not bypass.*upload/i],
    ["This video is not available in your country", /geo-blocked.*does not bypass.*upload/i],
    ["Video has been removed", /removed.*upload/i],
    ["Sign in to confirm you're not a bot", /bot check.*does not bypass.*upload/i]
  ])("maps %s without attempting a workaround", (output, expected) => {
    expect(mapYtDlpError(output)).toMatch(expected);
  });
});
