export const MAX_VOICE_TIMER_DELAY_MS = 2_147_483_647;

/** Normalize externally supplied voice timeouts before passing them to Node timers. */
export function normalizeVoiceTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_VOICE_TIMER_DELAY_MS)
    : fallback;
}
