import { normalizeVoiceTimeoutMs } from "./timeout-utils.js";

/** Shared fetch-response helpers for the cloud STT/TTS adapters (openai-whisper, openai-tts). */

export const DEFAULT_VOICE_FETCH_TIMEOUT_MS = 60_000;

/**
 * Bound a cloud voice request so an unreachable provider cannot pin a voice
 * turn forever. The finite timer ceiling avoids Node's overflow behavior for
 * externally supplied timeout settings.
 */
export async function fetchWithVoiceTimeout(
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_VOICE_FETCH_TIMEOUT_MS
): Promise<Response> {
  const effectiveTimeoutMs = normalizeVoiceTimeoutMs(timeoutMs, DEFAULT_VOICE_FETCH_TIMEOUT_MS);
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(effectiveTimeoutMs) });
}

/** Best-effort error-body read for a non-ok HTTP response — never throws. */
export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return `<status ${response.status}>`;
  }
}
