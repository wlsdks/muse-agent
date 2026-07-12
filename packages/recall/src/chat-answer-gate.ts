/**
 * The deterministic grounding + citation gate for an agent CHAT turn — the SAME
 * anti-fabrication core the CLI chat surface (`stripFabricatedCitations` →
 * `withUngroundableFallback(enforceAnswerCitations(…))`) and the `muse ask`
 * pipeline (`finalizeRecall`) already apply, packaged once so a NON-CLI surface
 * (the API `/chat` endpoints) can gate an answer identically instead of returning
 * the raw model output. This closes the audited hole where API chat surfaced
 * uncited/fabricated claims while ask and CLI chat gated them.
 *
 * It is pure + synchronous (no model call): the deterministic half of "shows its
 * work". A model call (reverify judge) is deliberately NOT wired here — the
 * content downgrade is citation-driven and deterministic, which keeps the gate
 * fail-close and free of any provider dependency on the server path.
 */

import {
  enforceAnswerCitations,
  stripGroundingFences,
  verifyGrounding,
  withUngroundableFallback,
  type GroundingVerdict,
  type KnowledgeMatch
} from "@muse/agent-core";

import { stripEchoedCiteAs } from "./text.js";

/** One piece of evidence the runtime turn actually produced — a read-tool output
 *  (`source: toolName`) or an injected inbox message (`source: "inbox/<provider>"`),
 *  the shape of `AgentRunResult.groundingSources`. */
export interface ChatGroundingSource {
  readonly source: string;
  readonly text: string;
}

export interface GatedChatAnswer {
  /** The answer to surface — sentences whose only citation names a non-retrieved
   *  source are dropped by code; the honest hedge stands when every sentence is
   *  un-groundable. A grounded answer passes through byte-identical. */
  readonly answer: string;
  /** Deterministic grounding verdict of the gated answer against the run's evidence
   *  (`grounded` / `weak` / `ungrounded`) — the response-envelope signal (parity with
   *  `/api/ask`'s reported verdict). */
  readonly groundingVerdict: GroundingVerdict;
  /** Citation targets the gate stripped as fabricated — non-empty means the model
   *  cited a source that was NOT in the run's grounding evidence. */
  readonly strippedCitations: readonly string[];
  /** True when the gate changed the model's raw answer (dropped a sentence / hedged
   *  / normalised a citation) — lets the caller skip rebuilding an unchanged result. */
  readonly gated: boolean;
}

/** Reduce a grounding-source id to the short citation ref the model would have
 *  cited (`[from <ref>]`): the path under `/notes/`, else the basename, else the id
 *  verbatim (a bare tool name like `knowledge_search`). Mirrors the CLI's
 *  `shortCitationRef` so both surfaces resolve citations against the same form. */
function citationRef(source: string): string {
  const marker = "/notes/";
  const idx = source.lastIndexOf(marker);
  if (idx >= 0) return source.slice(idx + marker.length);
  if (source.includes("/") || source.includes("\\")) {
    const parts = source.split(/[/\\]/u);
    return parts[parts.length - 1] ?? source;
  }
  return source;
}

/**
 * Gate a chat answer against the evidence the runtime turn produced.
 *
 * Deterministic pipeline, identical in spirit to the ask path and CLI chat:
 *   1. strip an echoed grounding FENCE / "cite as" INSTRUCTION the model parroted,
 *   2. `enforceAnswerCitations` DROPS any sentence whose only citation names a
 *      source NOT in the evidence — a fabricated citation can never reach the user
 *      BY CODE — and `withUngroundableFallback` surfaces the honest hedge when every
 *      sentence is dropped,
 *   3. `verifyGrounding` reports the verdict for the response envelope.
 *
 * FAIL-CLOSE without OVER-GATING: content is downgraded ONLY by the citation gate,
 * never by token-coverage, so a legitimately-grounded (or a general, un-cited)
 * answer passes through UNCHANGED — matching the CLI chat gate, which likewise does
 * not refuse a general turn on coverage alone.
 */
/**
 * The citation set a chat turn's evidence permits — shared by the buffered
 * gate below AND the live stream filter in the API's SSE layer, so the two
 * can never diverge (a span the live filter passes is exactly a span the
 * buffered gate would keep).
 */
export function chatAllowedCitations(evidence: readonly ChatGroundingSource[]): { readonly notes: readonly string[] } {
  return { notes: evidence.map((source) => citationRef(source.source)) };
}

export function gateChatAnswerGrounding(args: {
  readonly question: string;
  readonly answer: string;
  readonly evidence: readonly ChatGroundingSource[];
}): GatedChatAnswer {
  const allowedNotes = [...chatAllowedCitations(args.evidence).notes];
  const cleaned = stripEchoedCiteAs(stripGroundingFences(args.answer));
  const enforced = enforceAnswerCitations(cleaned, { notes: allowedNotes });
  const answer = withUngroundableFallback(enforced);

  const matches: readonly KnowledgeMatch[] = args.evidence.map((source) => ({
    cosine: 1,
    score: 1,
    source: source.source,
    text: source.text,
    trusted: false
  }));
  const { verdict } = verifyGrounding(answer, matches, args.question);

  return {
    answer,
    gated: answer !== args.answer,
    groundingVerdict: verdict,
    strippedCitations: enforced.stripped
  };
}
