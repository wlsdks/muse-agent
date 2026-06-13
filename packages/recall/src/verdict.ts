import { verifyGrounding, verifyGroundingWithReverify, type GroundingReverify, type KnowledgeMatch } from "@muse/agent-core";

import { answerIsRefusal } from "./text.js";

export interface BestOfRedrawArgs {
  /** How many fresh drafts to draw (the n-1 of --best-of n). */
  readonly attempts: number;
  /** One fresh model draft, already bound to the run's prompt + temperature. */
  readonly draw: () => Promise<string>;
  /** The same normalize + citation gate the first draft went through. */
  readonly clean: (draft: string) => string;
  readonly isRefusal: (draft: string) => boolean;
  /** Content-citation expansion so the verdict scores claims, not markers. */
  readonly expand: (draft: string) => string;
  /** Deterministic best-grounded pick over the expanded drafts. */
  readonly select: (drafts: readonly string[]) => { readonly index: number } | undefined;
  /** The full (reverify-backed) gate — undefined means grounded. */
  readonly confirm: (verdictText: string) => Promise<string | undefined>;
}

/**
 * The --best-of resample: draw fresh drafts, let the deterministic verifier
 * pick the best grounded survivor, then require the FULL gate to confirm it.
 * Returns the confirmed survivor or undefined — fail-close, so no survivor
 * means the original warning path stands and a fabrication is never admitted.
 */
export async function drawBestGroundedRedraft(args: BestOfRedrawArgs): Promise<string | undefined> {
  const redrafts: string[] = [];
  for (let draw = 0; draw < args.attempts; draw += 1) {
    const cleaned = args.clean(await args.draw());
    if (cleaned.trim().length > 0 && !args.isRefusal(cleaned)) {
      redrafts.push(cleaned);
    }
  }
  const best = args.select(redrafts.map((draft) => args.expand(draft)));
  if (!best) {
    return undefined;
  }
  const survivor = redrafts[best.index];
  if (survivor === undefined) {
    return undefined;
  }
  return (await args.confirm(args.expand(survivor))) === undefined ? survivor : undefined;
}

/**
 * Output-side grounding VERDICT for the chat-only recall wedge — the rubric
 * verifier (`verifyGrounding`) run AFTER citation stripping, over the grounded
 * passages. Where `enforceAnswerCitations` removes a fabricated citation, this
 * catches the subtler failure the citation gate can't: a confident retrieval
 * whose ANSWER then drifts beyond the evidence (low coverage). Returns a
 * user-facing notice ONLY for an `ungrounded` verdict on a non-refusal answer;
 * `grounded`/`weak` stay silent (weak is already handled by the low-confidence
 * input framing, a refusal asserts no claim). Only valid where `matches` IS the
 * full evidence — the chat-only path, never `--with-tools`.
 */
export async function groundingVerdictNotice(
  answer: string,
  matches: readonly KnowledgeMatch[],
  query: string,
  reverify?: GroundingReverify,
  reverifySamples?: number
): Promise<string | undefined> {
  if (answerIsRefusal(answer)) return undefined;
  const verification = reverify
    ? await verifyGroundingWithReverify(answer, matches, query, reverify, { reverifySamples })
    : verifyGrounding(answer, matches, query);
  if (verification.verdict !== "ungrounded") return undefined;
  return `\n⚠️  Grounding check: this answer's claims aren't fully backed by your notes (${verification.reason}) — treat as unverified.\n`;
}
