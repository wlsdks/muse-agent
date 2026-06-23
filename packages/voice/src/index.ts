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
  TtsFormat,
  TtsPersona
} from "./types.js";
export { VoiceProviderError, VoiceValidationError } from "./errors.js";
export { resolveTtsPersona, type ResolvedTtsPersona } from "./persona.js";
export {
  OpenAIWhisperSttProvider,
  type OpenAIWhisperSttProviderOptions
} from "./openai-whisper.js";
export {
  WhisperCppSttProvider,
  createWhisperCppRunner,
  type WhisperCppRunResult,
  type WhisperCppRunner,
  type WhisperCppSttProviderOptions
} from "./whisper-cpp.js";
export {
  OpenAITtsProvider,
  type OpenAITtsProviderOptions
} from "./openai-tts.js";
export {
  PiperTtsProvider,
  createPiperRunner,
  type PiperRunResult,
  type PiperRunner,
  type PiperTtsProviderOptions
} from "./piper.js";
export { VoiceProviderRegistry } from "./registry.js";
export {
  FakeAudioFrameWakeWordDetector,
  TextScanWakeWordDetector,
  type AudioFrameWakeWordDetector,
  type AudioFrameWakeWordDetectorInfo,
  type AudioFrameWakeWordDetectorResult,
  type FakeAudioFrameWakeWordDetectorOptions,
  type TextScanWakeWordDetectorOptions,
  type WakeWordDetector,
  type WakeWordDetectorInfo,
  type WakeWordDetectorResult
} from "./wake-word.js";
export {
  FakeLiveVoiceProvider,
  FakeLiveVoiceSession,
  type FakeLiveVoiceProviderOptions,
  type LiveVoiceEvent,
  type LiveVoiceOpenOptions,
  type LiveVoiceProvider,
  type LiveVoiceProviderInfo,
  type LiveVoiceSession
} from "./live-voice.js";
export {
  buildGeminiLiveAudioFrame,
  buildGeminiLiveEndTurnFrame,
  buildGeminiLiveSetupFrame,
  parseGeminiLiveServerFrame,
  type GeminiLiveSetupOptions
} from "./gemini-live-protocol.js";
