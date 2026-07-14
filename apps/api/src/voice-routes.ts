import type { MuseAuth } from "@muse/auth";
import {
  VoiceProviderError,
  VoiceValidationError,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
  type TtsFormat,
  type VoiceProviderRegistry
} from "@muse/voice";
import type { FastifyInstance, FastifyReply } from "fastify";

import { toBody } from "./compat-parsers.js";
import { requireAuthenticated } from "./server-helpers.js";

/**
 * `/api/voice/*` routes — Phase D of the voice-mode rollout (see
 * `docs/design/voice-mode.md`).
 *
 * Three endpoints:
 *   - `GET  /api/voice/providers` — describe the configured STT and
 *     TTS providers.
 *   - `POST /api/voice/stt` — transcribe an audio clip via the
 *     selected STT provider. Body is JSON `{ audioBase64, mimeType,
 *     language?, providerId? }`. Returns `{ text, language?,
 *     durationMs? }`.
 *   - `POST /api/voice/tts` — synthesize speech via the selected TTS
 *     provider. Body is JSON `{ text, voice?, format?, providerId? }`.
 *     Returns the binary audio body with the appropriate
 *     `Content-Type`. The full audio is returned in one shot —
 *     streaming is deferred to Phase F.
 *
 * Browser side (Phase E) captures via MediaRecorder, base64-encodes,
 * POSTs to `/api/voice/stt`, plays the response from `/api/voice/tts`
 * through an `<audio>` element. Keeping API keys server-side this
 * way avoids leaking them into the page.
 */

export interface VoiceRoutesGate {
  readonly registry: VoiceProviderRegistry;
  readonly authService?: MuseAuth;
}

export function registerVoiceRoutes(server: FastifyInstance, gate: VoiceRoutesGate): void {
  server.get("/api/voice/providers", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    return {
      stt: gate.registry.listStt().map((provider) => provider.describe()),
      tts: gate.registry.listTts().map((provider) => provider.describe())
    };
  });

  server.post("/api/voice/stt", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = toBody(request.body);

    const audioBase64 = typeof body?.audioBase64 === "string" ? body.audioBase64 : "";
    const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "";
    if (audioBase64.length === 0 || mimeType.length === 0) {
      return reply.status(400).send({ error: "audioBase64 and mimeType are required" });
    }

    let audio: Uint8Array;
    try {
      audio = new Uint8Array(Buffer.from(audioBase64, "base64"));
    } catch {
      return reply.status(400).send({ error: "audioBase64 is not valid base64" });
    }
    if (audio.byteLength === 0) {
      return reply.status(400).send({ error: "audioBase64 decoded to zero bytes" });
    }

    const provider = resolveStt(gate, body?.providerId);
    if (!provider) {
      return reply.status(503).send({ error: "no STT provider is configured" });
    }

    try {
      const result = await provider.transcribe({
        audio,
        mimeType,
        ...(typeof body?.language === "string" && body.language.length > 0 ? { language: body.language } : {})
      });
      return {
        durationMs: result.durationMs,
        language: result.language,
        providerId: provider.id,
        text: result.text
      };
    } catch (error) {
      return sendVoiceError(reply, error);
    }
  });

  server.post("/api/voice/tts", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = toBody(request.body);

    const text = typeof body?.text === "string" ? body.text : "";
    if (text.trim().length === 0) {
      return reply.status(400).send({ error: "text is required" });
    }

    const provider = resolveTts(gate, body?.providerId);
    if (!provider) {
      return reply.status(503).send({ error: "no TTS provider is configured" });
    }

    try {
      const result = await provider.synthesize({
        text,
        ...(typeof body?.voice === "string" && body.voice.length > 0 ? { voice: body.voice } : {}),
        ...(typeof body?.format === "string" ? { format: body.format } : {})
      });
      reply.header("Content-Type", result.mimeType);
      reply.header("X-Voice-Provider", provider.id);
      reply.header("X-Voice-Format", result.format);
      return reply.send(Buffer.from(result.audio));
    } catch (error) {
      return sendVoiceError(reply, error);
    }
  });
}

function resolveStt(gate: VoiceRoutesGate, providerId: string | undefined): SpeechToTextProvider | undefined {
  if (providerId && providerId.length > 0) {
    return gate.registry.requireStt(providerId);
  }
  return gate.registry.primaryStt();
}

function resolveTts(gate: VoiceRoutesGate, providerId: string | undefined): TextToSpeechProvider | undefined {
  if (providerId && providerId.length > 0) {
    return gate.registry.requireTts(providerId);
  }
  return gate.registry.primaryTts();
}

function sendVoiceError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof VoiceValidationError) {
    return reply.status(400).send({ code: error.code, error: error.message });
  }
  if (error instanceof VoiceProviderError) {
    const status = error.code.startsWith("HTTP_4") ? 502 : 502;
    return reply.status(status).send({
      code: error.code,
      error: error.message,
      providerId: error.providerId
    });
  }
  // Unexpected (non-typed) failure: log the raw detail
  // server-side but never echo it to the network client — a raw
  // Error message can leak internal paths / ECONNREFUSED hosts /
  // connection URIs. Typed Voice*Error branches above keep their
  // curated, client-safe messages.
  reply.log.error({ err: error }, "voice route internal error");
  return reply.status(500).send({ code: "VOICE_INTERNAL_ERROR", error: "internal voice processing error" });
}
