/**
 * Muse Voice — provider-neutral speech I/O.
 *
 * Phase B of the voice-mode rollout (see `docs/design/voice-mode.md`).
 * Ships the abstractions plus OpenAI Whisper / OpenAI TTS adapters as
 * the default cloud backends. Future iterations slot Whisper.cpp,
 * Piper, ElevenLabs, Apple Speech and Gemini Live in by implementing
 * `SpeechToTextProvider` / `TextToSpeechProvider` without touching the
 * agent or the API surface.
 */

export type {
  SpeechToTextProvider,
  SttProviderInfo,
  SttRequest,
  SttResponse,
  TextToSpeechProvider,
  TtsProviderInfo,
  TtsRequest,
  TtsResponse,
  TtsFormat
} from "./types.js";
export { VoiceProviderError, VoiceValidationError } from "./errors.js";
export {
  OpenAIWhisperSttProvider,
  type OpenAIWhisperSttProviderOptions
} from "./openai-whisper.js";
export {
  WhisperCppSttProvider,
  type WhisperCppRunResult,
  type WhisperCppRunner,
  type WhisperCppSttProviderOptions
} from "./whisper-cpp.js";
export {
  OpenAITtsProvider,
  type OpenAITtsProviderOptions
} from "./openai-tts.js";
export { VoiceProviderRegistry } from "./registry.js";
