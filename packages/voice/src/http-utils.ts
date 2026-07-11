/** Shared fetch-response helpers for the cloud STT/TTS adapters (openai-whisper, openai-tts). */

/** Best-effort error-body read for a non-ok HTTP response — never throws. */
export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return `<status ${response.status}>`;
  }
}
