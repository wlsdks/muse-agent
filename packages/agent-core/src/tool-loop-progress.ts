/**
 * Tool-loop no-progress (stall) detection — early-exit when the agent is trapped
 * re-issuing near-identical READS that don't advance state.
 *
 * Extrinsic early-exit (arXiv:2505.17616, Lu et al., EMNLP 2025 Findings): an
 * embodied agent "frequently trapped in repetitive loops or issuing ineffective
 * commands" should halt when successive actions stop advancing — trading a tiny
 * progress drop for a large cut in redundant steps. Applied to Muse's tool loop:
 * when the last `window` consecutive READ observations are mutually
 * near-identical, the loop withholds tools for the next turn, forcing a clean
 * final synthesis instead of burning the remaining maxToolCalls budget on spin
 * that ends in "max tool call limit reached" errors.
 *
 * A WRITE/EXECUTE tool is progress by definition (it changed the world), so it
 * RESETS the stall window — a legitimate retry-after-write is never cut. This
 * detects REPEATED observations (the SAME read returned again — a genuinely
 * lexical phenomenon), not paraphrase similarity, so token-Jaccard at a HIGH
 * floor is the right signal. Distinct from the exact-signature dedup the
 * deduplicator already does (that keys on name:args and never re-runs an
 * identical call; this catches DIFFERENT calls whose RESULTS are near-identical).
 */

// Hangul / Han / Kana are word chars; everything else splits (mirrors the
// CJK-aware tokenisers elsewhere) so a repeated Korean observation is caught.
const STALL_NON_WORD_RE = /[^a-z0-9가-힯一-鿿぀-ゟ゠-ヿ]+/u;

function stallTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(STALL_NON_WORD_RE)) {
    if (raw.length >= 2) out.add(raw);
  }
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // two empty observations are identical
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export const TOOL_LOOP_STALL_WINDOW = 3;
// HIGH (0.92): only a near-verbatim repetition of the SAME read trips it; a
// progressing read (different page / different query result) scores well below.
export const TOOL_LOOP_STALL_JACCARD = 0.92;

/**
 * True iff the last `window` read observations are all mutually near-identical
 * (every adjacent pair token-Jaccard ≥ threshold) — a stalled read loop. Fewer
 * than `window` observations → not stalled (need evidence of repetition). Pure,
 * deterministic, never throws.
 */
export function detectToolLoopStall(
  readObservations: readonly string[],
  opts?: { readonly window?: number; readonly threshold?: number }
): boolean {
  const window = Math.max(2, Math.trunc(opts?.window ?? TOOL_LOOP_STALL_WINDOW));
  const threshold = opts?.threshold ?? TOOL_LOOP_STALL_JACCARD;
  if (readObservations.length < window) return false;
  const last = readObservations.slice(-window).map(stallTokens);
  for (let i = 1; i < last.length; i += 1) {
    if (jaccard(last[i - 1]!, last[i]!) < threshold) return false;
  }
  return true;
}

/**
 * Stateful wrapper for the tool loop: record each genuinely-executed tool result
 * (a mutating one resets the read window — it advanced state), then query
 * stalled() at the top of the next turn.
 */
export class ToolLoopProgressTracker {
  private reads: string[] = [];

  record(output: string, mutating: boolean): void {
    if (mutating) {
      this.reads = [];
      return;
    }
    this.reads.push(output);
  }

  stalled(opts?: { readonly window?: number; readonly threshold?: number }): boolean {
    return detectToolLoopStall(this.reads, opts);
  }
}
