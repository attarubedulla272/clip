import { describe, expect, it } from "vitest";
import { OllamaProvider } from "./ollama-provider.js";

describe("Ollama metadata requests", () => {
  it("uses JSON mode, a bounded output, a 60-second timeout, and the requested section", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedSignal: AbortSignal | undefined;
    const provider = new OllamaProvider(
      "http://localhost:11434",
      "llama3.2:3b",
      async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedSignal = init?.signal as AbortSignal;
        return new Response(JSON.stringify({ response: "{\"description\":\"A short description.\"}" }), { status: 200 });
      }
    );
    const controller = new AbortController();
    await provider.generateMetadataPartJson({
      transcript: "A brief transcript about astronomy and planets.",
      videoTitle: "Astronomy",
      videoType: "tutorial",
      language: "same",
      tone: "curious",
      signal: controller.signal
    }, "description");

    expect(capturedBody).toBeDefined();
    const body = capturedBody as {
      format?: unknown;
      options?: { num_ctx?: number; num_predict?: number; temperature?: number };
      prompt?: string;
    };
    expect(body.format).toBeDefined();
    expect(body.options?.num_predict).toBe(240);
    expect(body.options?.num_ctx).toBe(1024);
    expect(body.options?.temperature).toBe(0.1);
    expect(body.prompt).toContain("Generate only the description fields");
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});
