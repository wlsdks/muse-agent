import { describe, expect, it } from "vitest";

import { VoiceProviderError, VoiceValidationError } from "../src/errors.js";
import { OpenAIWhisperSttProvider } from "../src/openai-whisper.js";

// Direct coverage for the CLOUD OpenAI Whisper STT adapter (untested module).
// It's the privacy-sensitive one (mic audio leaving the box), so this pins both
// the request it makes (endpoint + Bearer auth + multipart body) and that it
// self-describes local:false — the marker the local-only wiring reads to REFUSE
// registering it. Contract-faithful fetch fake, no network.

const audio = new Uint8Array([1, 2, 3, 4]);
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });

const capturingFetch = (response: Response | (() => Promise<Response>)) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ init, url });
    return typeof response === "function" ? response() : response;
  }) as unknown as typeof fetch;
  return Object.assign(impl, { calls });
};

describe("OpenAIWhisperSttProvider", () => {
  it("requires an API key and self-describes as a CLOUD (local:false) provider", () => {
    expect(() => new OpenAIWhisperSttProvider({ apiKey: "" })).toThrow(VoiceValidationError);
    const p = new OpenAIWhisperSttProvider({ apiKey: "sk-x", fetchImpl: capturingFetch(jsonResponse({ text: "" })) });
    expect(p.describe()).toMatchObject({ id: "openai-whisper", local: false }); // the local-only gate keys off this
  });

  it("POSTs a multipart request to the OpenAI transcriptions endpoint with Bearer auth and maps the result", async () => {
    const fetchImpl = capturingFetch(jsonResponse({ duration: 2.5, language: "en", text: "hello world" }));
    const p = new OpenAIWhisperSttProvider({ apiKey: "sk-test", fetchImpl });
    const res = await p.transcribe({ audio, language: "en", mimeType: "audio/wav" });
    expect(res).toMatchObject({ durationMs: 2500, language: "en", text: "hello world" }); // duration sec → ms
    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(call.init.body).toBeInstanceOf(FormData);
  });

  it("omits invalid remote duration values instead of exposing NaN, Infinity, or a negative duration", async () => {
    for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const p = new OpenAIWhisperSttProvider({ apiKey: "sk-test", fetchImpl: capturingFetch(jsonResponse({ duration, text: "hello" })) });
      await expect(p.transcribe({ audio, mimeType: "audio/wav" })).resolves.toMatchObject({ durationMs: undefined, text: "hello" });
    }
  });

  it("aborts a stalled cloud request at the configured timeout", async () => {
    const stalled: typeof fetch = ((_url: string, init: RequestInit) => {
      const pending = Promise.withResolvers<Response>();
      init.signal?.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
      return pending.promise;
    }) as typeof fetch;
    const p = new OpenAIWhisperSttProvider({ apiKey: "sk-test", fetchImpl: stalled, timeoutMs: 20 });
    await expect(p.transcribe({ audio, mimeType: "audio/wav" })).rejects.toMatchObject({ code: "FETCH_FAILED" });
  });

  it("rejects empty audio / missing mimeType / unsupported format BEFORE any network call", async () => {
    const fetchImpl = capturingFetch(jsonResponse({ text: "x" }));
    const p = new OpenAIWhisperSttProvider({ apiKey: "k", fetchImpl });
    await expect(p.transcribe({ audio: new Uint8Array([]), mimeType: "audio/wav" })).rejects.toMatchObject({ code: "EMPTY_AUDIO" });
    await expect(p.transcribe({ audio, mimeType: "" })).rejects.toMatchObject({ code: "MISSING_MIME_TYPE" });
    await expect(p.transcribe({ audio, mimeType: "audio/x-weird" })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    expect(fetchImpl.calls).toHaveLength(0); // never reached the network
  });

  it("maps a thrown fetch, a non-2xx status, invalid JSON, and a missing text field to typed VoiceProviderErrors", async () => {
    const threw = new OpenAIWhisperSttProvider({ apiKey: "k", fetchImpl: capturingFetch(() => Promise.reject(new Error("net down"))) });
    await expect(threw.transcribe({ audio, mimeType: "audio/wav" })).rejects.toMatchObject({ code: "FETCH_FAILED" });

    const http = new OpenAIWhisperSttProvider({ apiKey: "k", fetchImpl: capturingFetch(jsonResponse({ error: "bad key" }, 401)) });
    await expect(http.transcribe({ audio, mimeType: "audio/wav" })).rejects.toMatchObject({ code: "HTTP_401" });

    const badJson = new OpenAIWhisperSttProvider({ apiKey: "k", fetchImpl: capturingFetch(new Response("not json", { status: 200 })) });
    await expect(badJson.transcribe({ audio, mimeType: "audio/wav" })).rejects.toMatchObject({ code: "BAD_JSON" });

    const badShape = new OpenAIWhisperSttProvider({ apiKey: "k", fetchImpl: capturingFetch(jsonResponse({ notText: 1 })) });
    const err = await badShape.transcribe({ audio, mimeType: "audio/wav" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceProviderError);
    expect((err as VoiceProviderError).code).toBe("BAD_SHAPE");
  });
});
