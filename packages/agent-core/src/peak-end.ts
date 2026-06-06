/**
 * Peak-end digest — the peak-end rule (Kahneman et al., Psychological Science
 * 1993) as a deterministic, no-model session summary.
 *
 * People remember an episode by its PEAK moment and its END, not by integrating
 * every moment (duration neglect). So a two-point digest — the most salient turn
 * plus the closing turn — carries most of an episode's re-evocative power at a
 * fraction of the cost, and (crucially for Muse) it is GROUNDED by construction:
 * it only ever quotes turns that actually happened, so it can't fabricate a
 * memory. Its job is to be the fallback when the LLM summariser is unavailable
 * or errors, so a session is captured as a terse real memory instead of lost.
 *
 * Pure + deterministic.
 */

export interface DigestTurn {
  readonly role: string;
  readonly content: string;
}

// A turn is salient when it carries a number, a decision/commitment marker, or
// emphasis — the moments a person would remember as the "peak" of a chat.
const SALIENCE_MARKER = /\d|결정|정했|할게요?|해야|약속|중요|important|decid|will\b|must\b|need to|!/iu;

function salience(content: string): number {
  const text = content.trim();
  return text.length + (SALIENCE_MARKER.test(text) ? 40 : 0);
}

function clip(content: string, maxChars: number): string {
  const collapsed = content.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

/**
 * A two-point peak-end digest of a session, or null when there's nothing to
 * digest. The PEAK is the most salient non-final turn; the END is the last turn.
 */
export function peakEndDigest(turns: readonly DigestTurn[], maxChars = 120): string | null {
  const meaningful = turns.filter((turn) => turn.content.trim().length > 0);
  if (meaningful.length === 0) {
    return null;
  }
  const end = meaningful[meaningful.length - 1]!;
  const candidates = meaningful.length > 1 ? meaningful.slice(0, -1) : meaningful;
  const peak = candidates.reduce((best, turn) => (salience(turn.content) > salience(best.content) ? turn : best), candidates[0]!);
  if (peak === end) {
    return `Session ended on: "${clip(end.content, maxChars)}"`;
  }
  return `Peak: "${clip(peak.content, maxChars)}". Ended on: "${clip(end.content, maxChars)}".`;
}
