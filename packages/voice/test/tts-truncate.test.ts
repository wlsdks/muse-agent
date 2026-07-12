import { describe, expect, it } from "vitest";

import { truncateForTts, VoiceProviderRegistry } from "../src/index.js";
import type { TextToSpeechProvider, TtsRequest, TtsResponse } from "../src/index.js";

describe("truncateForTts (MED-2)", () => {
  it("returns short text byte-identical (the common case)", () => {
    expect(truncateForTts("Hello there.", 8_000)).toBe("Hello there.");
  });

  it("truncates at a sentence boundary and appends a cue", () => {
    const text = `${"First sentence here. ".repeat(3)}${"x".repeat(60)}`;
    const out = truncateForTts(text, 70);
    expect(out.endsWith(" (truncated)")).toBe(true);
    expect(out).toContain("First sentence here.");
    expect(out).not.toContain("xxxx"); // the tail blob is dropped
  });

  it("falls back to a word boundary when no sentence end fits", () => {
    const out = truncateForTts("alpha beta gamma delta epsilon zeta eta theta", 20);
    expect(out.endsWith(" (truncated)")).toBe(true);
    expect(out).not.toMatch(/\S\(truncated\)/u); // didn't cut mid-word against the cue
  });

  it("maxChars<=0 disables truncation", () => {
    expect(truncateForTts("anything at all", 0)).toBe("anything at all");
  });

  it("never leaves a lone surrogate when the cap lands mid-emoji (no space/sentence boundary nearby)", () => {
    const LONE_SURROGATE = /[\ud800-\udfff]/u;
    const text = `${"a".repeat(9)}😀${"a".repeat(9)}`; // cap 10 lands on the emoji's high surrogate (index 9)
    const out = truncateForTts(text, 10);
    expect(LONE_SURROGATE.test(out)).toBe(false);
    expect(out).toBe(`${"a".repeat(9)} (truncated)`);
  });

  it("Korean input under the cap is returned byte-identical", () => {
    const ko = "안녕하세요 반갑습니다 좋은 하루 되세요";
    expect(truncateForTts(ko, 8_000)).toBe(ko);
  });
});

function capturingTts(seen: TtsRequest[]): TextToSpeechProvider {
  return {
    id: "cap",
    describe: () => ({ id: "cap", displayName: "cap", description: "", local: true, availableVoices: [], supportedFormats: ["wav"] }),
    synthesize: async (request: TtsRequest): Promise<TtsResponse> => {
      seen.push(request);
      return { audio: new Uint8Array(), mimeType: "audio/wav", format: "wav" };
    }
  };
}

describe("registry caps over-long TTS text before dispatch", () => {
  it("synthesizeWithPersona truncates a huge text", async () => {
    const seen: TtsRequest[] = [];
    const reg = new VoiceProviderRegistry();
    reg.registerTts(capturingTts(seen));
    await reg.synthesizeWithPersona({ id: "muse", providerId: "cap" }, { text: "word ".repeat(5_000) });
    expect(seen[0]!.text.length).toBeLessThan(9_000);
    expect(seen[0]!.text.endsWith(" (truncated)")).toBe(true);
  });

  it("synthesizeWithFallback passes short text through unchanged", async () => {
    const seen: TtsRequest[] = [];
    const reg = new VoiceProviderRegistry();
    reg.registerTts(capturingTts(seen));
    await reg.synthesizeWithFallback({ text: "just a short line" });
    expect(seen[0]!.text).toBe("just a short line");
  });
});
