import { describe, expect, it } from "vitest";

import { VoiceProviderError } from "../src/errors.js";
import { VoiceProviderRegistry } from "../src/registry.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "../src/types.js";

// Direct unit coverage for the voice provider registry (was an entirely
// untested export). Voice mode pairs one STT + one TTS; the registry is the
// lookup surface the wiring + CLI read. The registry holds whatever is
// registered (the local-only egress filtering happens upstream in the
// autoconfigure wiring, not here) — so these pin the lookup contract: insertion
// order, first-is-primary, overwrite-on-duplicate-id, and the fail-loud
// require() with a registered-ids hint.

const stt = (id: string): SpeechToTextProvider => ({ id }) as SpeechToTextProvider;
const tts = (id: string): TextToSpeechProvider => ({ id }) as TextToSpeechProvider;

describe("VoiceProviderRegistry", () => {
  it("an empty registry lists nothing, has no primary, and require() throws NOT_FOUND with a (none registered) hint", () => {
    const r = new VoiceProviderRegistry();
    expect(r.listStt()).toEqual([]);
    expect(r.listTts()).toEqual([]);
    expect(r.primaryStt()).toBeUndefined();
    expect(r.primaryTts()).toBeUndefined();
    const err = (() => { try { r.requireStt("ollama"); return undefined; } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(VoiceProviderError);
    expect((err as VoiceProviderError).code).toBe("STT_NOT_FOUND");
    expect((err as Error).message).toContain("(none registered)");
  });

  it("primary is the FIRST registered (insertion order), and list reflects that order", () => {
    const r = new VoiceProviderRegistry();
    r.registerStt(stt("whisper-cpp"));
    r.registerStt(stt("openai"));
    expect(r.primaryStt()?.id).toBe("whisper-cpp");
    expect(r.listStt().map((p) => p.id)).toEqual(["whisper-cpp", "openai"]);
    expect(r.requireStt("openai").id).toBe("openai");
  });

  it("registering a duplicate id overwrites in place (no duplicate entry)", () => {
    const r = new VoiceProviderRegistry();
    r.registerStt(stt("whisper-cpp"));
    r.registerStt(stt("openai"));
    const replacement = stt("whisper-cpp");
    r.registerStt(replacement);
    expect(r.listStt()).toHaveLength(2);
    expect(r.requireStt("whisper-cpp")).toBe(replacement); // the latest instance wins
  });

  it("requireStt for an unknown id throws with the registered ids listed", () => {
    const r = new VoiceProviderRegistry();
    r.registerStt(stt("whisper-cpp"));
    r.registerStt(stt("openai"));
    const err = (() => { try { r.requireStt("nope"); return undefined; } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(VoiceProviderError);
    expect((err as Error).message).toContain("whisper-cpp, openai");
  });

  it("STT and TTS are independent maps (registering one never affects the other)", () => {
    const r = new VoiceProviderRegistry();
    r.registerStt(stt("whisper-cpp"));
    expect(r.listTts()).toEqual([]);
    expect(r.primaryTts()).toBeUndefined();
    r.registerTts(tts("piper"));
    expect(r.primaryTts()?.id).toBe("piper");
    expect(r.listStt().map((p) => p.id)).toEqual(["whisper-cpp"]); // STT unchanged
    expect(() => r.requireTts("piper")).not.toThrow();
  });
});
