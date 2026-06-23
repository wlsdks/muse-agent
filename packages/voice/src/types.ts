/**
 * Provider-neutral voice abstractions.
 *
 * Mirrors the `ModelProvider` / `CalendarProvider` / `NotesProvider`
 * shape used elsewhere in Muse. Two pillars:
 *
 *   - `SpeechToTextProvider`: take audio bytes + mime type, return
 *     transcribed text + optional language / duration metadata.
 *   - `TextToSpeechProvider`: take text + optional voice id + format,
 *     return audio bytes + mime type.
 *
 * Adapters live in their own files (e.g. `openai-whisper.ts`,
 * `openai-tts.ts`). New providers — Apple Speech, Whisper.cpp,
 * ElevenLabs, Gemini Live — slot in by implementing the interface
 * without touching the agent or the API surface.
 */

export interface SttProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local: boolean;
  readonly supportedFormats: readonly string[];
}

export interface SttRequest {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly language?: string;
}

export interface SttResponse {
  readonly text: string;
  readonly language?: string;
  readonly durationMs?: number;
  readonly raw?: unknown;
}

export interface SpeechToTextProvider {
  readonly id: string;
  describe(): SttProviderInfo;
  transcribe(request: SttRequest): Promise<SttResponse>;
}

export interface TtsProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local: boolean;
  readonly availableVoices: readonly string[];
  readonly supportedFormats: readonly TtsFormat[];
}

export type TtsFormat = "mp3" | "wav" | "opus" | "aac" | "flac";

export interface TtsRequest {
  readonly text: string;
  readonly voice?: string;
  readonly format?: TtsFormat;
  readonly speed?: number;
}

export interface TtsResponse {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly format: TtsFormat;
  readonly raw?: unknown;
}

/**
 * A named bundle of TTS defaults (which provider + voice/format/speed)
 * so the same "voice of Muse" is reused across calls without every
 * caller restating provider/voice. A per-call TtsRequest field always
 * overrides the persona's value.
 */
export interface TtsPersona {
  readonly id: string;
  readonly providerId?: string;
  readonly voice?: string;
  readonly format?: TtsFormat;
  readonly speed?: number;
}

export interface TextToSpeechProvider {
  readonly id: string;
  describe(): TtsProviderInfo;
  synthesize(request: TtsRequest): Promise<TtsResponse>;
}
