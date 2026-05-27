import type { SpeechToTextProvider } from "@muse/voice";

import { captureWavForSeconds, safeTranscribe, type ListenShells } from "./commands-listen.js";
import type { ProgramIO } from "./program.js";

export interface VoiceCaptureDeps {
  readonly shells: ListenShells;
  readonly stt: SpeechToTextProvider;
  /** Seconds of mic audio to record before transcribing. */
  readonly clipSeconds: number;
  /** STT language hint (e.g. "ko"); omit for auto. */
  readonly language?: string;
}

/**
 * Capture one short mic clip and transcribe it to text — the shared
 * "speak a thought" primitive, reusing `muse listen`'s mic capture +
 * resilient STT. Returns `undefined` when nothing was captured (empty
 * audio — no mic / no speech) or transcription failed (safeTranscribe is
 * fail-soft), so a caller can report "nothing captured" instead of writing
 * an empty entry.
 */
export async function captureVoiceText(
  deps: VoiceCaptureDeps,
  io: Pick<ProgramIO, "stderr">
): Promise<string | undefined> {
  const wav = await captureWavForSeconds(deps.shells, deps.clipSeconds);
  if (wav.length === 0) {
    return undefined;
  }
  const text = await safeTranscribe(
    deps.stt,
    { audio: wav, mimeType: "audio/wav", ...(deps.language ? { language: deps.language } : {}) },
    io
  );
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
