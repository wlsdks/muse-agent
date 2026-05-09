import { describe, expect, it } from "vitest";
import {
  OpenAITtsProvider,
  OpenAIWhisperSttProvider,
  VoiceProviderRegistry
} from "@muse/voice";

import { buildServer } from "../src/server.js";

describe("api server: /api/voice/*", () => {
  it("GET /api/voice/providers describes registered STT and TTS providers", async () => {
    const registry = new VoiceProviderRegistry();
    registry.registerStt(new OpenAIWhisperSttProvider({ apiKey: "k", fetchImpl: stubFetch() }));
    registry.registerTts(new OpenAITtsProvider({ apiKey: "k", fetchImpl: stubFetch() }));
    const server = buildServer({ logger: false, voice: registry });

    const reply = await server.inject({ method: "GET", url: "/api/voice/providers" });
    expect(reply.statusCode).toBe(200);
    const body = reply.json() as { stt: { id: string }[]; tts: { id: string }[] };
    expect(body.stt[0]?.id).toBe("openai-whisper");
    expect(body.tts[0]?.id).toBe("openai-tts");
  });

  it("POST /api/voice/stt decodes base64 audio, calls the configured STT, and returns the transcription", async () => {
    const fetchImpl = async (url: string, init: RequestInit) => {
      expect(url).toContain("/v1/audio/transcriptions");
      const form = init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      const file = form.get("file") as Blob;
      expect(file.type).toBe("audio/wav");
      expect(file.size).toBe(4);
      return new Response(JSON.stringify({ text: "hello world", language: "en", duration: 0.42 }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };
    const registry = new VoiceProviderRegistry();
    registry.registerStt(new OpenAIWhisperSttProvider({ apiKey: "k", fetchImpl }));
    const server = buildServer({ logger: false, voice: registry });

    const audio = Buffer.from(Uint8Array.from([0, 1, 2, 3])).toString("base64");
    const reply = await server.inject({
      method: "POST",
      payload: { audioBase64: audio, mimeType: "audio/wav", language: "en" },
      url: "/api/voice/stt"
    });
    expect(reply.statusCode).toBe(200);
    const body = reply.json() as { text: string; language: string; durationMs: number; providerId: string };
    expect(body.text).toBe("hello world");
    expect(body.language).toBe("en");
    expect(body.durationMs).toBe(420);
    expect(body.providerId).toBe("openai-whisper");
  });

  it("POST /api/voice/stt rejects empty audio with 400", async () => {
    const registry = new VoiceProviderRegistry();
    registry.registerStt(new OpenAIWhisperSttProvider({ apiKey: "k", fetchImpl: stubFetch() }));
    const server = buildServer({ logger: false, voice: registry });

    const reply = await server.inject({
      method: "POST",
      payload: { audioBase64: "", mimeType: "audio/wav" },
      url: "/api/voice/stt"
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toMatchObject({ error: expect.stringContaining("audioBase64") });
  });

  it("POST /api/voice/stt returns 503 when no STT provider is registered", async () => {
    const registry = new VoiceProviderRegistry();
    const server = buildServer({ logger: false, voice: registry });

    const reply = await server.inject({
      method: "POST",
      payload: { audioBase64: "AQID", mimeType: "audio/wav" },
      url: "/api/voice/stt"
    });
    expect(reply.statusCode).toBe(503);
  });

  it("POST /api/voice/tts proxies through the configured TTS and returns audio bytes", async () => {
    const audio = new Uint8Array([10, 20, 30, 40, 50]);
    const fetchImpl = async (url: string, init: RequestInit) => {
      expect(url).toContain("/v1/audio/speech");
      const body = JSON.parse(init.body as string);
      expect(body.input).toBe("hi there");
      expect(body.voice).toBe("nova");
      expect(body.response_format).toBe("mp3");
      return new Response(audio, { status: 200 });
    };
    const registry = new VoiceProviderRegistry();
    registry.registerTts(new OpenAITtsProvider({ apiKey: "k", fetchImpl }));
    const server = buildServer({ logger: false, voice: registry });

    const reply = await server.inject({
      method: "POST",
      payload: { format: "mp3", text: "hi there", voice: "nova" },
      url: "/api/voice/tts"
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["content-type"]).toBe("audio/mpeg");
    expect(reply.headers["x-voice-provider"]).toBe("openai-tts");
    expect(reply.headers["x-voice-format"]).toBe("mp3");
    expect(Array.from(reply.rawPayload)).toEqual([10, 20, 30, 40, 50]);
  });

  it("POST /api/voice/tts rejects empty text with 400", async () => {
    const registry = new VoiceProviderRegistry();
    registry.registerTts(new OpenAITtsProvider({ apiKey: "k", fetchImpl: stubFetch() }));
    const server = buildServer({ logger: false, voice: registry });

    const reply = await server.inject({
      method: "POST",
      payload: { text: "   " },
      url: "/api/voice/tts"
    });
    expect(reply.statusCode).toBe(400);
  });

  it("POST /api/voice/tts maps provider failures to 502", async () => {
    const fetchImpl = async () => new Response("Unauthorized", { status: 401 });
    const registry = new VoiceProviderRegistry();
    registry.registerTts(new OpenAITtsProvider({ apiKey: "bad", fetchImpl }));
    const server = buildServer({ logger: false, voice: registry });

    const reply = await server.inject({
      method: "POST",
      payload: { text: "hi" },
      url: "/api/voice/tts"
    });
    expect(reply.statusCode).toBe(502);
    expect(reply.json()).toMatchObject({ code: "HTTP_401", providerId: "openai-tts" });
  });

  it("voice routes are absent when no registry is configured", async () => {
    const server = buildServer({ logger: false });
    const reply = await server.inject({ method: "GET", url: "/api/voice/providers" });
    expect(reply.statusCode).toBe(404);
  });
});

function stubFetch(): (input: string, init: RequestInit) => Promise<Response> {
  return async () => new Response("{}", { status: 200 });
}
