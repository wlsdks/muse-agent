import { describe, expect, it, vi } from "vitest";

import {
  OpenAITtsProvider,
  OpenAIWhisperSttProvider,
  VoiceProviderError,
  VoiceProviderRegistry,
  VoiceValidationError
} from "../src/index.js";

const apiKey = "sk-test";

describe("OpenAIWhisperSttProvider", () => {
  it("requires an api key", () => {
    expect(() => new OpenAIWhisperSttProvider({ apiKey: "", fetchImpl: dummyFetch() })).toThrow(
      VoiceValidationError
    );
  });

  it("describes itself", () => {
    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl: dummyFetch() });
    const info = provider.describe();
    expect(info.id).toBe("openai-whisper");
    expect(info.local).toBe(false);
    expect(info.supportedFormats).toContain("audio/wav");
  });

  it("rejects empty audio", async () => {
    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl: dummyFetch() });
    await expect(
      provider.transcribe({ audio: new Uint8Array(0), mimeType: "audio/wav" })
    ).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("rejects missing mime type", async () => {
    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl: dummyFetch() });
    await expect(
      provider.transcribe({ audio: new Uint8Array([1, 2, 3]), mimeType: "" })
    ).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("posts multipart form-data with the model and parses the response", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${apiKey}`);
      const body = init.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect(body.get("model")).toBe("whisper-1");
      expect(body.get("response_format")).toBe("json");
      const file = body.get("file") as Blob;
      expect(file.type).toBe("audio/wav");
      return new Response(
        JSON.stringify({ text: "hello world", language: "en", duration: 1.25 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl });
    const result = await provider.transcribe({
      audio: new Uint8Array([0, 1, 2, 3]),
      mimeType: "audio/wav",
      language: "en"
    });

    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    expect(result.durationMs).toBe(1250);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("wraps non-2xx as VoiceProviderError with HTTP code", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("upstream boom", { status: 503 })
    );
    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl });
    const error = await provider
      .transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" })
      .catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("HTTP_503");
  });

  it("rejects responses missing the `text` field", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const provider = new OpenAIWhisperSttProvider({ apiKey, fetchImpl });
    const error = await provider
      .transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" })
      .catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("BAD_SHAPE");
  });
});

describe("OpenAITtsProvider", () => {
  it("requires an api key", () => {
    expect(() => new OpenAITtsProvider({ apiKey: "", fetchImpl: dummyFetch() })).toThrow(
      VoiceValidationError
    );
  });

  it("describes itself", () => {
    const provider = new OpenAITtsProvider({ apiKey, fetchImpl: dummyFetch() });
    const info = provider.describe();
    expect(info.id).toBe("openai-tts");
    expect(info.availableVoices).toContain("alloy");
    expect(info.supportedFormats).toContain("mp3");
  });

  it("rejects empty text", async () => {
    const provider = new OpenAITtsProvider({ apiKey, fetchImpl: dummyFetch() });
    await expect(provider.synthesize({ text: "  " })).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("posts a JSON body with model + voice + format and returns audio bytes", async () => {
    const audio = new Uint8Array([10, 20, 30, 40]);
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${apiKey}`);
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("tts-1");
      expect(body.voice).toBe("nova");
      expect(body.input).toBe("hi there");
      expect(body.response_format).toBe("mp3");
      return new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } });
    });

    const provider = new OpenAITtsProvider({ apiKey, fetchImpl });
    const result = await provider.synthesize({ text: "hi there", voice: "nova" });

    expect(result.format).toBe("mp3");
    expect(result.mimeType).toBe("audio/mpeg");
    expect(Array.from(result.audio)).toEqual([10, 20, 30, 40]);
  });

  it("rejects unsupported formats at the provider boundary", async () => {
    const provider = new OpenAITtsProvider({ apiKey, fetchImpl: dummyFetch() });
    await expect(
      provider.synthesize({ text: "x", format: "bogus" as never })
    ).rejects.toBeInstanceOf(VoiceValidationError);
  });

  it("wraps non-2xx as VoiceProviderError with HTTP code", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const provider = new OpenAITtsProvider({ apiKey, fetchImpl });
    const error = await provider.synthesize({ text: "hi" }).catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("HTTP_401");
  });

  it("rejects empty audio bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(0), { status: 200 }));
    const provider = new OpenAITtsProvider({ apiKey, fetchImpl });
    const error = await provider.synthesize({ text: "hi" }).catch((err) => err);
    expect(error).toBeInstanceOf(VoiceProviderError);
    expect((error as VoiceProviderError).code).toBe("EMPTY_BODY");
  });
});

describe("VoiceProviderRegistry", () => {
  it("registers and looks up providers by id", () => {
    const registry = new VoiceProviderRegistry();
    const stt = new OpenAIWhisperSttProvider({ apiKey, fetchImpl: dummyFetch() });
    const tts = new OpenAITtsProvider({ apiKey, fetchImpl: dummyFetch() });
    registry.registerStt(stt);
    registry.registerTts(tts);
    expect(registry.primaryStt()?.id).toBe("openai-whisper");
    expect(registry.primaryTts()?.id).toBe("openai-tts");
    expect(registry.requireStt("openai-whisper")).toBe(stt);
    expect(registry.requireTts("openai-tts")).toBe(tts);
  });

  it("throws for unknown ids", () => {
    const registry = new VoiceProviderRegistry();
    expect(() => registry.requireStt("missing")).toThrow(VoiceProviderError);
    expect(() => registry.requireTts("missing")).toThrow(VoiceProviderError);
  });
});

function dummyFetch(): (input: string, init: RequestInit) => Promise<Response> {
  return async () => new Response("{}", { status: 200 });
}
