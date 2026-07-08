import { describe, expect, it } from "vitest";

import { buildVoiceRegistry } from "../src/registry-builders/voice.js";

describe("buildVoiceRegistry — MUSE_LOCAL_ONLY closes cloud audio egress", () => {
  it("an OpenAI key registers cloud STT+TTS under the explicit local-only-off (control)", () => {
    // Cloud is allowed by default; MUSE_LOCAL_ONLY=false is the explicit-off control.
    const registry = buildVoiceRegistry({ MUSE_LOCAL_ONLY: "false", OPENAI_API_KEY: "k" });
    expect(registry).toBeDefined();
    expect(registry?.primaryStt()?.id).toBe("openai-whisper");
    expect(registry?.primaryTts()?.id).toBe("openai-tts");
  });

  it("an OpenAI key alone under the DEFAULT (no flag) ⇒ cloud voice registers (cloud allowed by default)", () => {
    const registry = buildVoiceRegistry({ OPENAI_API_KEY: "k" });
    expect(registry).toBeDefined();
    expect(registry?.primaryStt()?.id).toBe("openai-whisper");
    expect(registry?.primaryTts()?.id).toBe("openai-tts");
  });

  it("local-only + OpenAI key ONLY ⇒ no surface (undefined) — audio never leaves the box", () => {
    const registry = buildVoiceRegistry({ OPENAI_API_KEY: "k", MUSE_LOCAL_ONLY: "true" });
    expect(registry).toBeUndefined();
  });

  it("local-only ignores the OpenAI key but still registers local Whisper.cpp; no cloud TTS leaks", () => {
    const registry = buildVoiceRegistry({
      OPENAI_API_KEY: "k",
      MUSE_VOICE_STT: "whisper-cpp",
      MUSE_LOCAL_ONLY: "true"
    });
    expect(registry).toBeDefined();
    expect(registry?.primaryStt()?.id).toBe("whisper-cpp");
    expect(registry?.listTts()).toHaveLength(0); // OpenAI TTS suppressed
    expect(registry?.listStt().some((p) => p.id.includes("openai"))).toBe(false);
  });

  it("local-only with Piper TTS configured registers Piper, no OpenAI providers", () => {
    const registry = buildVoiceRegistry({
      OPENAI_API_KEY: "k",
      MUSE_VOICE_TTS: "piper",
      MUSE_PIPER_VOICE: "/voices/en.onnx",
      MUSE_LOCAL_ONLY: "true"
    });
    expect(registry?.primaryTts()?.id).toBe("piper");
    expect(registry?.listStt().some((p) => p.id.includes("openai"))).toBe(false);
    expect(registry?.listTts().some((p) => p.id.includes("openai"))).toBe(false);
  });
});
