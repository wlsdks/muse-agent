# @muse/voice

Owns Muse's provider-neutral speech I/O abstraction: STT/TTS provider interfaces, cloud (OpenAI
Whisper/TTS) and local (Whisper.cpp, Piper) adapters implementing them, wake-word detection, and
the Gemini Live streaming-voice wire protocol. It is a package rather than a folder because every
future speech backend must satisfy the same two interfaces without the agent or API surface
knowing which one is active.

## Public surface

- `SpeechToTextProvider`, `TextToSpeechProvider`, `SttRequest`/`SttResponse`,
  `TtsRequest`/`TtsResponse`, `TtsPersona` — the provider-neutral STT/TTS contract.
- `OpenAIWhisperSttProvider`, `OpenAITtsProvider` — cloud adapters.
- `WhisperCppSttProvider`, `createWhisperCppRunner`, `resolveDefaultWhisperModelPath` — local STT
  adapter shelling out to a `whisper.cpp` binary.
- `PiperTtsProvider`, `createPiperRunner` — local TTS adapter shelling out to a `piper` binary.
- `VoiceProviderRegistry` — holds the active STT/TTS providers a caller selected.
- `resolveTtsPersona`, `truncateForTts` — persona-to-voice-parameter resolution and TTS input caps.
- `FakeAudioFrameWakeWordDetector`, `TextScanWakeWordDetector`, `WakeWordDetector` — wake-word
  detection abstraction and its test/text-scan implementations.
- `FakeLiveVoiceProvider`, `LiveVoiceProvider`, `LiveVoiceSession` — streaming live-voice session
  abstraction (currently a fake reference implementation).
- `buildGeminiLiveSetupFrame`, `buildGeminiLiveAudioFrame`, `parseGeminiLiveServerFrame` — Gemini
  Live wire-protocol frame builders/parsers.
- `VoiceProviderError`, `VoiceValidationError` — the provider error taxonomy.

## Depends on

- `@muse/shared` — common primitives.

## Rules that bind this package

This package ships both cloud and local STT/TTS adapters side by side and does not itself decide
which one is active. Under `MUSE_LOCAL_ONLY=true`, the consumer — `@muse/autoconfigure`'s
`buildVoiceRegistry` (`packages/autoconfigure/src/registry-builders/voice.ts`) — treats an OpenAI
key as absent so only `WhisperCppSttProvider`/`PiperTtsProvider` can register, per the local-only
posture in [`../../.claude/rules/architecture.md`](../../.claude/rules/architecture.md); this
package's job is to keep the local adapters fully substitutable for the cloud ones, not to enforce
the gate itself.

## Tests

```bash
pnpm --filter @muse/voice test
```
