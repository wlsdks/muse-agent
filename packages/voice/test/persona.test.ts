import { describe, expect, it } from "vitest";

import { resolveTtsPersona, VoiceProviderRegistry } from "../src/index.js";
import type { TextToSpeechProvider, TtsPersona, TtsRequest, TtsResponse } from "../src/index.js";

describe("resolveTtsPersona", () => {
  const persona: TtsPersona = { id: "muse", providerId: "piper", voice: "calm", format: "wav", speed: 1.1 };

  it("fills gaps from the persona when the request omits fields", () => {
    const r = resolveTtsPersona(persona, { text: "hi" });
    expect(r.providerId).toBe("piper");
    expect(r.request).toEqual({ text: "hi", voice: "calm", format: "wav", speed: 1.1 });
  });

  it("lets explicit request fields override the persona", () => {
    const r = resolveTtsPersona(persona, { text: "hi", voice: "bright", speed: 1.5 });
    expect(r.request.voice).toBe("bright"); // request wins
    expect(r.request.speed).toBe(1.5);
    expect(r.request.format).toBe("wav"); // gap filled from persona
  });

  it("is a near no-op with no persona (only the request's own fields)", () => {
    const req: TtsRequest = { text: "hi", voice: "x" };
    const r = resolveTtsPersona(undefined, req);
    expect(r.providerId).toBeUndefined();
    expect(r.request).toEqual({ text: "hi", voice: "x" });
  });
});

describe("VoiceProviderRegistry.synthesizeWithPersona", () => {
  function fakeTts(id: string, seen: TtsRequest[]): TextToSpeechProvider {
    return {
      id,
      describe: () => ({ id, displayName: id, description: "", local: true, availableVoices: [], supportedFormats: ["wav"] }),
      synthesize: async (request: TtsRequest): Promise<TtsResponse> => {
        seen.push(request);
        return { audio: new Uint8Array(), mimeType: "audio/wav", format: "wav" };
      }
    };
  }

  it("dispatches to the persona's provider with persona defaults applied", async () => {
    const seen: TtsRequest[] = [];
    const registry = new VoiceProviderRegistry();
    registry.registerTts(fakeTts("piper", seen));
    await registry.synthesizeWithPersona({ id: "muse", providerId: "piper", voice: "calm" }, { text: "hello" });
    expect(seen).toEqual([{ text: "hello", voice: "calm" }]);
  });

  it("falls back to the primary provider when the persona names none", async () => {
    const seen: TtsRequest[] = [];
    const registry = new VoiceProviderRegistry();
    registry.registerTts(fakeTts("primary", seen));
    await registry.synthesizeWithPersona({ id: "muse", voice: "calm" }, { text: "hi" });
    expect(seen).toEqual([{ text: "hi", voice: "calm" }]);
  });

  it("throws a clear error when no provider is available", async () => {
    const registry = new VoiceProviderRegistry();
    await expect(registry.synthesizeWithPersona({ id: "muse" }, { text: "hi" })).rejects.toThrow(/No TTS provider/);
  });
});

describe("VoiceProviderRegistry.synthesizeWithFallback", () => {
  function tts(id: string, behavior: "ok" | "fail", seen: string[]): TextToSpeechProvider {
    return {
      id,
      describe: () => ({ id, displayName: id, description: "", local: true, availableVoices: [], supportedFormats: ["wav"] }),
      synthesize: async (): Promise<TtsResponse> => {
        seen.push(id);
        if (behavior === "fail") throw new Error(`${id} down`);
        return { audio: new Uint8Array(), mimeType: "audio/wav", format: "wav" };
      }
    };
  }

  it("returns the first provider's result and does not try the rest", async () => {
    const seen: string[] = [];
    const registry = new VoiceProviderRegistry();
    registry.registerTts(tts("piper", "ok", seen));
    registry.registerTts(tts("backup", "ok", seen));
    await registry.synthesizeWithFallback({ text: "hi" });
    expect(seen).toEqual(["piper"]); // short-circuits on first success
  });

  it("falls through a failing provider to the next that succeeds", async () => {
    const seen: string[] = [];
    const registry = new VoiceProviderRegistry();
    registry.registerTts(tts("piper", "fail", seen));
    registry.registerTts(tts("backup", "ok", seen));
    await registry.synthesizeWithFallback({ text: "hi" });
    expect(seen).toEqual(["piper", "backup"]); // tried piper, fell to backup
  });

  it("honors an explicit provider order", async () => {
    const seen: string[] = [];
    const registry = new VoiceProviderRegistry();
    registry.registerTts(tts("piper", "ok", seen));
    registry.registerTts(tts("backup", "ok", seen));
    await registry.synthesizeWithFallback({ text: "hi" }, ["backup", "piper"]);
    expect(seen).toEqual(["backup"]);
  });

  it("throws naming every failure when all providers fail", async () => {
    const seen: string[] = [];
    const registry = new VoiceProviderRegistry();
    registry.registerTts(tts("piper", "fail", seen));
    registry.registerTts(tts("backup", "fail", seen));
    await expect(registry.synthesizeWithFallback({ text: "hi" })).rejects.toThrow(/piper: piper down.*backup: backup down/);
  });

  it("throws when no provider is registered", async () => {
    await expect(new VoiceProviderRegistry().synthesizeWithFallback({ text: "hi" })).rejects.toThrow(/No TTS provider/);
  });
});
