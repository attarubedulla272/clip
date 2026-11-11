import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clipMetadataResultSchema,
  validateMetadataRules,
  type ClipMetadataResult,
  type MetadataOptions
} from "@clipforge/shared/clip-metadata";
import { parseLlmProviderOrder } from "../config.js";
import {
  generateMetadataWithFallback,
  generateOfflineMetadata,
  type ClipMetadataCache,
  type ClipMetadataInput,
  type MetadataProvider
} from "./generate-clip-metadata.js";
import { GeminiProvider } from "./gemini-provider.js";
import type { ClipMetadataPart, ClipMetadataPromptInput } from "./llm-provider.js";

const transcript = "The solar system changes as planets move around the sun. Scientists study the solar system to understand planets and stars. This lesson explains how gravity shapes the planets.";
const input: ClipMetadataInput = {
  transcript,
  videoTitle: "Understanding the solar system",
  videoType: "tutorial",
  language: "same",
  tone: "curious",
  includeOriginalCredit: false,
  useGemini: false
};
const options: MetadataOptions = { language: "same", tone: "curious", includeOriginalCredit: false, useGemini: false };

function resultWith(overrides: Partial<ClipMetadataResult> = {}): ClipMetadataResult {
  return {
    youtube: {
      titleVariants: ["Solar system changes", "Planets move around the sun", "Gravity shapes the planets"],
      selectedTitleIndex: 0,
      description: [
        "The solar system changes as planets move.",
        "Scientists study the solar system.",
        "",
        "Scientists study the solar system to understand planets and stars.",
        "This lesson explains how gravity shapes the planets.",
        "",
        "Follow for more.",
        "",
        "#solar #system #planets"
      ].join("\n"),
      tags: ["solar", "system", "planets", "sun", "scientists", "gravity", "stars", "study", "lesson", "move"],
      hashtags: ["#solar", "#system", "#planets"]
    },
    instagramReels: { caption: "The solar system changes.\n\n#solar #system #planets" },
    tiktok: { caption: "Planets move around the sun.\n#solar #system #planets" },
    ...overrides
  };
}

function partJson(part: ClipMetadataPart, result = resultWith()) {
  if (part === "titles") return JSON.stringify({
    titleVariants: result.youtube.titleVariants,
    selectedTitleIndex: result.youtube.selectedTitleIndex
  });
  if (part === "title") return JSON.stringify({ title: result.youtube.titleVariants[0] });
  if (part === "description") {
    return JSON.stringify({ description: result.youtube.description.split(/\r?\n/).filter((line) => !line.startsWith("#")).join("\n").trim() });
  }
  if (part === "hashtags") return JSON.stringify({ tags: result.youtube.tags, hashtags: result.youtube.hashtags });
  return JSON.stringify({ instagramReels: result.instagramReels, tiktok: result.tiktok });
}

function createProvider(
  name: "Gemini" | "Ollama",
  response: (part: ClipMetadataPart, input: ClipMetadataPromptInput) => Promise<string> | string = (part) => partJson(part)
): MetadataProvider {
  return {
    providerName: name,
    modelName: name === "Gemini" ? "gemini-test" : "ollama-test",
    async generateMetadataPartJson(input, part) {
      return response(part, input);
    }
  };
}

function createCache(): ClipMetadataCache & {
  values: Map<string, {
    result: ClipMetadataResult;
    mode: "AI" | "Offline";
    provider: "Gemini" | "Ollama" | "Offline" | "Gemini + Offline" | "Ollama + Offline";
    fallbackReason?: string;
    warnings: Record<string, string[]>;
  }>;
} {
  const values = new Map<string, {
    result: ClipMetadataResult;
    mode: "AI" | "Offline";
    provider: "Gemini" | "Ollama" | "Offline" | "Gemini + Offline" | "Ollama + Offline";
    fallbackReason?: string;
    warnings: Record<string, string[]>;
  }>();
  return {
    values,
    async get(hash) {
      return values.get(hash);
    },
    async set(hash, value) {
      values.set(hash, value);
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GEMINI_API_KEY;
});

beforeEach(() => {
  process.env.GEMINI_API_KEY = "mock-gemini-key-for-tests";
});

describe("metadata safety validation", () => {
  it("hard-blocks promises, virality, all-caps spam, and invented numbers", () => {
    const unsafe = resultWith({
      youtube: {
        ...resultWith().youtube,
        titleVariants: ["SOLAR SYSTEM WILL GO VIRAL", "Planets move around the sun", "Gravity shapes the planets"],
        description: resultWith().youtube.description.replace("Follow for more.", "Follow for guaranteed results in 999 days.")
      }
    });
    const checked = validateMetadataRules(unsafe, transcript, { sourceTitle: input.videoTitle, videoType: input.videoType });
    expect(checked.success).toBe(false);
    if (!checked.success) {
      expect(checked.errors.join(" ")).toMatch(/ALL-CAPS|guarantee|viral|numbers/i);
    }
  });

  it("allows harmless unsupported synonyms with a soft warning", () => {
    const harmless = resultWith({
      youtube: {
        ...resultWith().youtube,
        titleVariants: ["Solar system overview", "Planets move around the sun", "Gravity shapes the planets"]
      }
    });
    const checked = validateMetadataRules(harmless, transcript, { sourceTitle: input.videoTitle, videoType: input.videoType });
    expect(checked.success).toBe(true);
    if (checked.success) {
      expect(checked.warnings.some((warning) => warning.field === "youtube.titleVariants.0")).toBe(true);
    }
  });

  it("hard-blocks an invented named person", () => {
    const inventedName = resultWith({
      youtube: {
        ...resultWith().youtube,
        description: resultWith().youtube.description.replace(
          "Scientists study the solar system to understand planets and stars.",
          "Dr. Jane Doe studies the solar system."
        )
      }
    });
    const checked = validateMetadataRules(inventedName, transcript, { sourceTitle: input.videoTitle, videoType: input.videoType });
    expect(checked.success).toBe(false);
    if (!checked.success) {
      expect(checked.errors.join(" ")).toContain("name not present");
    }
  });

  it("validates the final platform schema", () => {
    expect(clipMetadataResultSchema.safeParse(resultWith()).success).toBe(true);
    expect(clipMetadataResultSchema.safeParse({
      ...resultWith(),
      youtube: { ...resultWith().youtube, titleVariants: ["x".repeat(71), "Solar system", "Planets and stars"] }
    }).success).toBe(false);
  });
});

describe("metadata provider chain", () => {
  it("uses the configured provider order and reports why it moved to the next provider", async () => {
    expect(parseLlmProviderOrder()).toEqual(["gemini", "ollama", "offline"]);
    const order = parseLlmProviderOrder("gemini,ollama,offline");
    const called: string[] = [];
    const gemini = createProvider("Gemini", async () => {
      called.push("Gemini");
      throw new Error("temporary provider failure");
    });
    const ollama = createProvider("Ollama", async (part) => {
      if (!called.includes("Ollama")) called.push("Ollama");
      return partJson(part);
    });
    const generated = await generateMetadataWithFallback(
      { ...input, useGemini: true },
      options,
      [gemini, ollama],
      createCache(),
      [],
      order
    );
    expect(called).toEqual(["Gemini", "Ollama"]);
    expect(generated.provider).toBe("Ollama");
    expect(generated.fallbackReason).toContain("Gemini");
  });

  it("backs off on Gemini 429/quota responses, then falls back to Ollama", async () => {
    let geminiRequests = 0;
    let waits = 0;
    const gemini = new GeminiProvider(
      "test-key-not-for-logs",
      "gemini-test",
      async () => {
        geminiRequests += 1;
        return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 });
      },
      async () => { waits += 1; }
    );
    const ollama = createProvider("Ollama");
    const inputWithConsent = { ...input, useGemini: true };
    const generated = await generateMetadataWithFallback(inputWithConsent, options, [gemini, ollama], createCache());
    expect(geminiRequests).toBe(3);
    expect(waits).toBe(2);
    expect(generated.provider).toBe("Ollama");
    expect(generated.fallbackReason).toContain("quota limit");
  });

  it("does not use Gemini without explicit opt-in and sends no title, video type, or media file", async () => {
    let capturedBody = "";
    const gemini = new GeminiProvider(
      "mock-gemini-key-for-tests",
      "gemini-test",
      async (_url, init) => {
        capturedBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: partJson("titles") }] } }]
        }), { status: 200 });
      }
    );
    const skipped = await generateMetadataWithFallback(input, options, [gemini], createCache());
    expect(skipped.provider).toBe("Offline");
    expect(capturedBody).toBe("");

    await gemini.generateMetadataPartJson(input, "titles");
    const text = JSON.stringify(JSON.parse(capturedBody));
    expect(text).toContain(transcript);
    expect(text).not.toContain(input.videoTitle);
    expect(text).not.toContain(input.videoType);
    expect(text).not.toContain("file://");
  });

  it("skips Gemini when the key is not configured even if clip consent is on", async () => {
    delete process.env.GEMINI_API_KEY;
    let called = false;
    const gemini = createProvider("Gemini", async () => {
      called = true;
      return partJson("titles");
    });
    const generated = await generateMetadataWithFallback(
      { ...input, useGemini: true },
      options,
      [gemini],
      createCache(),
      [],
      ["gemini", "offline"]
    );
    expect(called).toBe(false);
    expect(generated.provider).toBe("Offline");
    expect(generated.fallbackReason).toContain("GEMINI_API_KEY is not configured");
  });

  it("regenerates only a rejected title field", async () => {
    const calls: ClipMetadataPart[] = [];
    const provider = createProvider("Ollama", async (part) => {
      calls.push(part);
      if (part === "titles") {
        return JSON.stringify({
          titleVariants: ["Solar system will go viral", "Planets move around the sun", "Gravity shapes the planets"],
          selectedTitleIndex: 0
        });
      }
      if (part === "title") return JSON.stringify({ title: "Solar system changes" });
      return partJson(part);
    });
    const generated = await generateMetadataWithFallback(input, options, [provider], createCache(), [], ["ollama", "offline"]);
    expect(calls.filter((part) => part === "title")).toHaveLength(1);
    expect(calls.filter((part) => part === "description")).toHaveLength(1);
    expect(generated.result.youtube.titleVariants[0]).toBe("Solar system changes");
    expect(generated.provider).toBe("Ollama");
  });

  it("uses Offline only for a field that remains hard-blocked after two retries", async () => {
    let titleRetries = 0;
    const provider = createProvider("Ollama", async (part) => {
      if (part === "titles") {
        return JSON.stringify({
          titleVariants: ["Solar system will go viral", "Planets move around the sun", "Gravity shapes the planets"],
          selectedTitleIndex: 0
        });
      }
      if (part === "title") {
        titleRetries += 1;
        return JSON.stringify({ title: "Solar system will go viral" });
      }
      return partJson(part);
    });
    const generated = await generateMetadataWithFallback(input, options, [provider], createCache(), [], ["ollama", "offline"]);
    expect(titleRetries).toBe(3);
    expect(generated.provider).toBe("Ollama + Offline");
    expect(generated.mode).toBe("AI");
    expect(generated.fallbackReason).toContain("those fields use Offline templates");
    expect(generated.warnings["youtube.titleVariants.0"]?.[0]).toContain("Hard-blocked");
  });

  it("never exposes an API key in fallback logs or returned status", async () => {
    const secret = "AIzaFakeKey123456789012345678901";
    process.env.GEMINI_API_KEY = secret;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gemini = createProvider("Gemini", async () => { throw new Error(`request failed ${secret}`); });
    const generated = await generateMetadataWithFallback(
      { ...input, useGemini: true },
      options,
      [gemini],
      createCache(),
      [],
      ["gemini", "offline"]
    );
    const output = `${JSON.stringify(generated)} ${warn.mock.calls.flat().join(" ")}`;
    expect(output).not.toContain(secret);
    expect(generated.provider).toBe("Offline");
  });

  it("generates offline output when every AI provider is unavailable", () => {
    const offline = generateOfflineMetadata(input, options);
    expect(offline.youtube.titleVariants).toHaveLength(3);
    expect(offline.youtube.tags.length).toBeGreaterThanOrEqual(10);
    expect(clipMetadataResultSchema.safeParse(offline).success).toBe(true);
  });

  it("caches generated results by content and provider configuration", async () => {
    const provider = createProvider("Ollama");
    const cache = createCache();
    const first = await generateMetadataWithFallback(input, options, [provider], cache);
    const second = await generateMetadataWithFallback(input, options, [provider], cache);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.provider).toBe("Ollama");
  });
});
