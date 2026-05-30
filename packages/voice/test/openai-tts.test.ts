import { describe, expect, it } from "vitest";

import { VoiceProviderError, VoiceValidationError } from "../src/errors.js";
import { OpenAITtsProvider } from "../src/openai-tts.js";

// Direct coverage for the CLOUD OpenAI TTS adapter (untested module, symmetric
// to the OpenAI Whisper STT one). Pins the request (endpoint + Bearer auth +
// JSON body) and the local:false self-description the local-only wiring reads to
// REFUSE registering it. Contract-faithful fetch fake, no network.

const audioResponse = (bytes: string | null, status = 200): Response =>
  new Response(bytes === null ? null : Buffer.from(bytes), { status });

const capturingFetch = (response: Response | (() => Promise<Response>)) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ init, url });
    return typeof response === "function" ? response() : response;
  }) as unknown as typeof fetch;
  return Object.assign(impl, { calls });
};

describe("OpenAITtsProvider", () => {
  it("requires an API key and self-describes as a CLOUD (local:false) provider", () => {
    expect(() => new OpenAITtsProvider({ apiKey: "" })).toThrow(VoiceValidationError);
    const p = new OpenAITtsProvider({ apiKey: "sk-x", fetchImpl: capturingFetch(audioResponse("a")) });
    expect(p.describe()).toMatchObject({ local: false }); // the local-only gate keys off this
  });

  it("POSTs a JSON body to the OpenAI speech endpoint with Bearer auth and returns the audio (default mp3)", async () => {
    const fetchImpl = capturingFetch(audioResponse("AUDIOBYTES"));
    const p = new OpenAITtsProvider({ apiKey: "sk-test", fetchImpl });
    const res = await p.synthesize({ text: "hello" });
    expect(res).toMatchObject({ format: "mp3", mimeType: "audio/mpeg" });
    expect(Buffer.from(res.audio).toString()).toBe("AUDIOBYTES");
    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(call.init.body)) as { input: string; model: string; voice: string; response_format: string };
    expect(body).toMatchObject({ input: "hello", response_format: "mp3" });
    expect(body.model.length).toBeGreaterThan(0);
    expect(body.voice.length).toBeGreaterThan(0);
  });

  it("threads an explicit voice + format into the request body", async () => {
    const fetchImpl = capturingFetch(audioResponse("x"));
    const p = new OpenAITtsProvider({ apiKey: "k", fetchImpl });
    await p.synthesize({ format: "wav", text: "hi", voice: "nova" });
    const body = JSON.parse(String(fetchImpl.calls[0]!.init.body)) as { voice: string; response_format: string };
    expect(body).toMatchObject({ response_format: "wav", voice: "nova" });
  });

  it("rejects empty text and an unsupported format BEFORE any network call", async () => {
    const fetchImpl = capturingFetch(audioResponse("x"));
    const p = new OpenAITtsProvider({ apiKey: "k", fetchImpl });
    await expect(p.synthesize({ text: "   " })).rejects.toMatchObject({ code: "EMPTY_TEXT" });
    await expect(p.synthesize({ format: "ogg-weird" as never, text: "x" })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("maps a thrown fetch, a non-2xx status, and an empty body to typed VoiceProviderErrors", async () => {
    const threw = new OpenAITtsProvider({ apiKey: "k", fetchImpl: capturingFetch(() => Promise.reject(new Error("net"))) });
    await expect(threw.synthesize({ text: "x" })).rejects.toMatchObject({ code: "FETCH_FAILED" });

    const http = new OpenAITtsProvider({ apiKey: "k", fetchImpl: capturingFetch(audioResponse("err", 500)) });
    await expect(http.synthesize({ text: "x" })).rejects.toMatchObject({ code: "HTTP_500" });

    const empty = new OpenAITtsProvider({ apiKey: "k", fetchImpl: capturingFetch(audioResponse("")) });
    const err = await empty.synthesize({ text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceProviderError);
    expect((err as VoiceProviderError).code).toBe("EMPTY_BODY");
  });
});
