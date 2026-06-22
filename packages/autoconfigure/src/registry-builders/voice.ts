/**
 * Voice-registry builder — env → `VoiceProviderRegistry` with the
 * personal-JARVIS subset: OpenAI Whisper (STT) + OpenAI TTS, with
 * optional local fallbacks (Whisper.cpp + Piper). Lifted from
 * `personal-providers.ts` following the same pattern as the
 * messaging and calendar builders.
 *
 * Returns `undefined` when nothing is registered so the
 * `/api/voice/*` routes stay absent (404) by default — that
 * matches the JARVIS-personal "no key, no surface" posture.
 *
 * STT selection (Phase F.2 — local Whisper.cpp):
 *   - `MUSE_VOICE_STT=whisper-cpp` → register `WhisperCppSttProvider`
 *     (no OpenAI key required). Binary / model paths come from
 *     `MUSE_WHISPER_CPP_PATH` and `MUSE_WHISPER_CPP_MODEL`.
 *   - `MUSE_VOICE_STT=openai-whisper` (default) → register
 *     `OpenAIWhisperSttProvider` when an OpenAI key is set.
 *
 * TTS selection (Phase F.3 — local Piper):
 *   - `MUSE_VOICE_TTS=piper` → register `PiperTtsProvider`
 *     (no OpenAI key required). Requires `MUSE_PIPER_VOICE` (path to
 *     a .onnx voice file). `MUSE_PIPER_PATH` overrides the binary.
 *   - `MUSE_VOICE_TTS=openai-tts` (default) → register
 *     `OpenAITtsProvider` when an OpenAI key is set.
 *
 * Env (OpenAI resolution order):
 *   - `MUSE_VOICE_OPENAI_API_KEY` — Muse-specific override.
 *   - `OPENAI_API_KEY` — standard convention.
 *   - When neither is set AND neither STT nor TTS chooses a local
 *     backend, the registry is empty and the routes are not
 *     registered (404).
 *   - `MUSE_VOICE_TTS_VOICE` — OpenAI voice name (alloy / echo / …).
 *   - `MUSE_VOICE_TTS_MODEL` / `MUSE_VOICE_STT_MODEL` — model overrides.
 */

import { accessSync, constants } from "node:fs";

import {
  OpenAITtsProvider,
  OpenAIWhisperSttProvider,
  PiperTtsProvider,
  VoiceProviderRegistry,
  WhisperCppSttProvider
} from "@muse/voice";

import { parseBoolean } from "../env-parsers.js";
import type { MuseEnvironment } from "../index.js";

/**
 * Synchronously look for `whisper-cli` (homebrew's binary name) or
 * `whisper-cpp` (project default) on $PATH. Returns the first hit
 * or undefined. Used so a user who just ran `brew install whisper-cpp`
 * doesn't need to set MUSE_WHISPER_CPP_PATH manually.
 */
function detectWhisperBinarySync(): string | undefined {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    for (const name of ["whisper-cli", "whisper-cpp"]) {
      const candidate = `${dir.replace(/\/+$/, "")}/${name}`;
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch { /* miss */ }
    }
  }
  return undefined;
}

export function buildVoiceRegistry(env: MuseEnvironment): VoiceProviderRegistry | undefined {
  const sttChoice = env.MUSE_VOICE_STT?.trim().toLowerCase();
  const ttsChoice = env.MUSE_VOICE_TTS?.trim().toLowerCase();
  const piperVoice = env.MUSE_PIPER_VOICE?.trim();
  // Local-only / no-cloud-egress: an OpenAI key MUST NOT route audio to
  // the cloud. Treating it as absent kills every cloud STT/TTS branch
  // below, so only Whisper.cpp / Piper register — and if neither is
  // configured the registry is empty (routes 404), never a silent send.
  const openAiKey = parseBoolean(env.MUSE_LOCAL_ONLY, true)
    ? undefined
    : (env.MUSE_VOICE_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim());
  const useLocalStt = sttChoice === "whisper-cpp";
  const useLocalTts = ttsChoice === "piper" && piperVoice && piperVoice.length > 0;

  if (!openAiKey && !useLocalStt && !useLocalTts) {
    return undefined;
  }

  const registry = new VoiceProviderRegistry();

  if (useLocalStt) {
    // Homebrew's whisper.cpp formula installs the binary as
    // `whisper-cli`, not `whisper-cpp`. Auto-resolve so the user
    // doesn't have to set MUSE_WHISPER_CPP_PATH after a plain
    // `brew install whisper-cpp`. Explicit env still wins.
    const explicitBinary = env.MUSE_WHISPER_CPP_PATH?.trim();
    const detectedBinary = explicitBinary && explicitBinary.length > 0
      ? explicitBinary
      : detectWhisperBinarySync();
    registry.registerStt(
      new WhisperCppSttProvider({
        ...(detectedBinary ? { binaryPath: detectedBinary } : {}),
        ...(env.MUSE_WHISPER_CPP_MODEL?.trim() ? { modelPath: env.MUSE_WHISPER_CPP_MODEL.trim() } : {})
      })
    );
  } else if (openAiKey) {
    registry.registerStt(
      new OpenAIWhisperSttProvider({
        apiKey: openAiKey,
        ...(env.MUSE_VOICE_STT_MODEL?.trim() ? { model: env.MUSE_VOICE_STT_MODEL.trim() } : {})
      })
    );
  }

  if (useLocalTts && piperVoice) {
    registry.registerTts(
      new PiperTtsProvider({
        modelPath: piperVoice,
        ...(env.MUSE_PIPER_PATH?.trim() ? { binaryPath: env.MUSE_PIPER_PATH.trim() } : {})
      })
    );
  } else if (openAiKey) {
    registry.registerTts(
      new OpenAITtsProvider({
        apiKey: openAiKey,
        ...(env.MUSE_VOICE_TTS_MODEL?.trim() ? { model: env.MUSE_VOICE_TTS_MODEL.trim() } : {}),
        ...(env.MUSE_VOICE_TTS_VOICE?.trim() ? { defaultVoice: env.MUSE_VOICE_TTS_VOICE.trim() } : {})
      })
    );
  }

  return registry;
}
