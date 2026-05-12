/**
 * Gemini Live wire-format parser + builders. Voice Phase F.3
 * follow-up scaffolding — ships the protocol shim so a future
 * `GeminiLiveProvider` (which implements `LiveVoiceProvider`) can
 * compose this parser with a real websocket client.
 *
 * The endpoint:
 *   wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
 *
 * Per Google's BidiGenerateContent reference:
 *   - Client opens the socket, sends `setup` once with model + voice
 *     config, waits for `setupComplete`.
 *   - Then streams `realtimeInput` frames with base64 PCM16 chunks.
 *   - Server replies with `serverContent` frames carrying `modelTurn`
 *     (parts: text and/or inlineData) and a `turnComplete` flag.
 *
 * Audio chunks the server returns are PCM16 at 24 kHz mono
 * (`audio/pcm;rate=24000`); callers usually re-wrap them into WAV
 * before handing them to a player. This module stays format-agnostic
 * and returns the raw bytes + mime type the model declared.
 *
 * No live websocket here — running the integration end-to-end
 * needs a real GOOGLE_API_KEY and dogfood validation of edge
 * cases (reconnect, partial-frame accumulation, voice-activity
 * detection signals). Tests assert the parser shape against
 * documented Gemini Live frames.
 */

import type { LiveVoiceEvent } from "./live-voice.js";

export interface GeminiLiveSetupOptions {
  /** e.g. `models/gemini-2.0-flash-live-001`. */
  readonly model: string;
  /** Voice id from Google's prebuilt set (e.g. "Aoede", "Charon"). */
  readonly voice?: string;
  /** Optional system prompt. Becomes `systemInstruction.parts[0].text`. */
  readonly system?: string;
  /**
   * Generation config — kept loose so callers can pass through
   * the documented Gemini Live fields without us locking the
   * schema before dogfood.
   */
  readonly generationConfig?: Record<string, unknown>;
}

/**
 * Build the one-shot `setup` frame the client sends right after the
 * websocket opens. Returns the JSON string ready to be sent through
 * `WebSocket.send()`.
 */
export function buildGeminiLiveSetupFrame(options: GeminiLiveSetupOptions): string {
  const setup: Record<string, unknown> = {
    model: options.model
  };
  if (options.voice) {
    setup.generationConfig = {
      ...(options.generationConfig ?? {}),
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: options.voice }
        }
      }
    };
  } else if (options.generationConfig) {
    setup.generationConfig = options.generationConfig;
  }
  if (options.system) {
    setup.systemInstruction = {
      parts: [{ text: options.system }]
    };
  }
  return JSON.stringify({ setup });
}

/**
 * Build a single-chunk `realtimeInput.mediaChunks` frame. Caller
 * supplies raw bytes + mime type; we base64-encode here.
 */
export function buildGeminiLiveAudioFrame(audio: Uint8Array, mimeType: string): string {
  return JSON.stringify({
    realtimeInput: {
      mediaChunks: [
        {
          data: bytesToBase64(audio),
          mimeType
        }
      ]
    }
  });
}

/**
 * Build the optional explicit turn-end signal. Gemini Live mostly
 * relies on voice-activity detection, but explicit `clientContent`
 * with `turnComplete: true` forces a turn boundary.
 */
export function buildGeminiLiveEndTurnFrame(): string {
  return JSON.stringify({
    clientContent: {
      turnComplete: true
    }
  });
}

/**
 * Parse a single server-side JSON frame into 0+ `LiveVoiceEvent`s.
 * Setup-complete and unknown frames return an empty array so the
 * caller's `for await` loop can ignore them without branching.
 *
 * Throws nothing — malformed JSON / unexpected shapes resolve to
 * `[{ type: "error", error }]` so the consumer sees them as part
 * of the normal event stream (per the LiveVoiceSession.events()
 * contract).
 */
export function parseGeminiLiveServerFrame(rawJson: string): readonly LiveVoiceEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (cause) {
    return [{
      error: cause instanceof Error ? cause : new Error("Gemini Live: malformed JSON frame"),
      type: "error"
    }];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  // setupComplete: server confirms our setup frame — no
  // user-visible LiveVoiceEvent.
  if (parsed.setupComplete !== undefined) {
    return [];
  }
  const serverContent = isRecord(parsed.serverContent) ? parsed.serverContent : undefined;
  if (!serverContent) {
    return [];
  }

  const events: LiveVoiceEvent[] = [];
  const modelTurn = isRecord(serverContent.modelTurn) ? serverContent.modelTurn : undefined;
  if (modelTurn && Array.isArray(modelTurn.parts)) {
    for (const part of modelTurn.parts) {
      if (!isRecord(part)) continue;
      if (typeof part.text === "string" && part.text.length > 0) {
        events.push({ text: part.text, type: "text-delta" });
        continue;
      }
      const inlineData = isRecord(part.inlineData) ? part.inlineData : undefined;
      if (
        inlineData
        && typeof inlineData.data === "string"
        && typeof inlineData.mimeType === "string"
      ) {
        try {
          events.push({
            audio: base64ToBytes(inlineData.data),
            mimeType: inlineData.mimeType,
            type: "audio-delta"
          });
        } catch (cause) {
          events.push({
            error: cause instanceof Error ? cause : new Error("Gemini Live: invalid base64 audio chunk"),
            type: "error"
          });
        }
      }
    }
  }
  if (serverContent.turnComplete === true) {
    events.push({ type: "turn-complete" });
  }
  if (serverContent.interrupted === true) {
    events.push({ type: "turn-complete" });
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  // Node + Bun both expose Buffer; the voice package is server-side
  // only (the web counterpart lives in apps/web with its own helper).
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}
