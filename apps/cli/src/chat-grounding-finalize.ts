import { enforceAnswerCitations, independentWitnessCount, quorumVerdict, withUngroundableFallback, type GroundingReverify, type KnowledgeMatch } from "@muse/agent-core";
import { conflictCueFromMatches, corroborationReceiptLine, stripEchoedCiteAs, stripGroundingFences, type MemoryFact } from "@muse/recall";
import { parseBooleanFromEnv } from "@muse/shared";

import { conversationMatches, resolveGroundingMinScore, shortCitationRef } from "./chat-grounding-evidence.js";
import {
  chatCitationPrecisionNotice,
  chatCitationRecallNotice,
  semanticConflictCueFromMatches,
  untrustedOnlyChatNotice
} from "./chat-grounding-notices.js";
import {
  expressesNoInformation,
  gateChatAnswer,
  gateChatAnswerDeterministic,
  gateChatAnswerWithReverify,
  isChatAbstention,
  noteGroundedAnswer
} from "./chat-grounding-verdict.js";

export interface FinalizeGatedChatAnswerArgs {
  readonly question: string;
  readonly answer: string;
  readonly matches: readonly KnowledgeMatch[];
  readonly history?: readonly { readonly role: string; readonly content: string }[];
  readonly toolsUsed?: readonly string[];
  /**
   * The `{ source, text }` evidence the read-tools actually produced this turn
   * (the agent run's `groundingSources`). When NON-EMPTY the semantic coverage
   * gate is skipped (a tool/web answer legitimately scores low note-coverage),
   * but the deterministic value checks STILL run against this evidence — so a
   * number/email the tool did not return is caught. A tool that RAN but produced
   * nothing leaves this empty, so the full gate runs (no blanket bypass).
   */
  readonly toolGroundingSources?: readonly { readonly source: string; readonly text: string }[];
  readonly knownFactKeys?: readonly string[];
  /**
   * The query-relevant remembered facts the persona injected this turn. Folded
   * into the cross-source conflict cue so a stale memory fact contradicting a
   * grounded note is surfaced on chat too (parity with `muse ask`). Keys alone
   * (`knownFactKeys`) can't conflict — the detector needs the value.
   */
  readonly memories?: readonly MemoryFact[];
  readonly reverify?: GroundingReverify;
  /**
   * Injectable embedder for semantic intra-evidence conflict detection. When
   * supplied (production wires the real recall embedder), two of the user's OWN
   * notes that disagree on the same fact in FREE PROSE are surfaced — the
   * labelled-field cue misses prose. Absent → fail-open (no semantic cue, the
   * labelled cue still runs). Tests inject a deterministic embedder.
   */
  readonly embed?: (text: string) => Promise<readonly number[]>;
}

/**
 * The ONE post-stream pipeline every conversational surface must run — the
 * audit found the Ink chat rendered the raw stream (no gate, no citation
 * strip, no receipt) while runLocalChat had all four steps inline, and the
 * divergence let a fabrication persist into the history as cosine-1
 * "conversation evidence". Shared here so the surfaces cannot drift again:
 * gate (reverify-backed when a judge is supplied) → truncated-citation strip →
 * fabricated-citation strip → source receipt.
 */
export interface FinalizedChatAnswer {
  /** The full answer to DISPLAY — gated answer + grounding receipt + source-check cues. */
  readonly display: string;
  /**
   * The answer to PERSIST to chat history / episodes / auto-memory — the gated answer
   * + receipt, WITHOUT the appended source-check cues. The cues are display-only
   * WARNINGS; persisting them lets `conversationMatches` replay them as cosine-1
   * TRUSTED grounding evidence next turn (an untrusted-source warning laundered into
   * trusted evidence — a grounded≠true self-pollution). Persist the answer, show the cues.
   */
  readonly forHistory: string;
  /**
   * `true` when this answer's grounding rested on UNTRUSTED sources (the
   * untrusted-only source-check cue fired). The REPL accumulates it across the
   * session and passes it to `captureEndOfSessionEpisode` so the stored episode is
   * marked `trusted:false` — closing the episode-laundering vector (MemoryGraft
   * arXiv:2512.16962). Same computation as the displayed cue (no drift).
   */
  readonly untrustedOnly: boolean;
}

export async function finalizeGatedChatAnswer(args: FinalizeGatedChatAnswerArgs): Promise<FinalizedChatAnswer> {
  // A tool's own output is evidence too — fold it in so the value checks treat a
  // value the tool actually returned as supported (cosine 1, like conversation).
  // trusted:false — tool output is NOT the user's own data; the provenance bit
  // feeds untrustedOnlyChatNotice (grounded≠true parity with the ask path).
  const toolEvidence: KnowledgeMatch[] = (args.toolGroundingSources ?? []).map(
    (source) => ({ cosine: 1, score: 1, source: source.source, text: source.text, trusted: false })
  );
  // Grounded by a tool ONLY when it produced real evidence — not merely because a
  // tool was called (a tool that ran but returned nothing must not bypass).
  const toolGrounded = toolEvidence.length > 0;
  const evidence = [...args.matches, ...conversationMatches(args.history ?? []), ...toolEvidence];
  const gated = toolGrounded
    ? gateChatAnswerDeterministic(args.question, args.answer, evidence, args.knownFactKeys ?? [])
    : args.reverify
      ? await gateChatAnswerWithReverify(args.question, args.answer, evidence, args.knownFactKeys ?? [], args.reverify)
      : gateChatAnswer(args.question, args.answer, evidence, args.knownFactKeys ?? []);
  const deFabbed = stripChatAnswerArtifacts(gated, args.matches.map((match) => match.source));
  const receipted = withGroundingReceipt(deFabbed, groundedNoteSources(args.matches, deFabbed), /[가-힣]/u.test(args.question));
  // grounded≠true: a faithful chat answer resting only on untrusted tool sources
  // gets the same scrutiny cue the ask path surfaces (every-surface parity).
  const untrustedCue = untrustedOnlyChatNotice(deFabbed, evidence);
  // grounded≠true: if two of the user's OWN grounded sources disagree on a field,
  // surface it on chat too (parity with `muse ask`).
  const conflictCue = conflictCueFromMatches(args.matches, args.memories);
  // grounded≠true: the labelled cue only sees `label: value` pairs. Two notes
  // disagreeing in FREE PROSE ("flight at 3pm" vs "at 6pm") slipped through and
  // the answer cited the matching half — a confident grounded lie. The semantic
  // value-conflict detector (ask-only until now) closes that ask↔chat parity
  // hole. Fail-open when no embedder is supplied (arXiv:2504.19413).
  const semanticConflictCue = args.embed
    ? await semanticConflictCueFromMatches(args.matches, args.embed)
    : undefined;
  // ALCE per-citation support + recall (parity with `muse ask`):
  // a cited source that doesn't support its sentence, or a citable claim with no
  // citation. Computed on the user's OWN grounded matches.
  const precisionCue = chatCitationPrecisionNotice(deFabbed, args.matches);
  const recallCue = chatCitationRecallNotice(deFabbed, args.matches);
  let out = receipted;
  if (untrustedCue) out += untrustedCue;
  if (conflictCue) out += `\n\n${conflictCue}`;
  if (semanticConflictCue) out += `\n\n${semanticConflictCue}`;
  if (precisionCue) out += `\n\n${precisionCue}`;
  if (recallCue) out += `\n\n${recallCue}`;
  // `forHistory` deliberately EXCLUDES the cues appended above (see FinalizedChatAnswer):
  // they are display-only warnings, not answer content, and must never be persisted
  // where conversationMatches would replay them as trusted grounding evidence.
  // `untrustedOnly` reuses the SAME cue computation (no drift) so the session-level
  // episode-trust verdict matches what the user was shown.
  return { display: out, forHistory: receipted, untrustedOnly: untrustedCue !== undefined };
}

/** The note/source refs (basenames) that actually grounded the answer — above the
 * authoritative threshold AND with content present in the answer, deduped. Drives
 * the accurate "source quoted" receipt on chat. */
export function groundedNoteSources(
  matches: readonly KnowledgeMatch[],
  answer: string,
  minScore: number = resolveGroundingMinScore()
): string[] {
  const answerLower = answer.toLowerCase();
  const refs = matches
    .filter((match) => (match.cosine ?? match.score) >= minScore && noteGroundedAnswer(match.text, answerLower))
    .map((match) => {
      const parts = match.source.trim().split(/[/\\]/u);
      return parts[parts.length - 1] ?? match.source.trim();
    })
    .filter((ref) => ref.length > 0);
  return [...new Set(refs)];
}

/**
 * Drop a DANGLING inline citation. In the grounded-recall runtime context the
 * local model sometimes stops mid-citation (`done_reason=stop`, e.g. "…[from
 * wifi_passwords/seoul_office." with no closing "]"), leaving a broken,
 * path-leaky fragment AND blocking the 📎 receipt (which skips when the answer
 * "[from"-contains a citation). Stripping the unclosed fragment lets the clean
 * receipt stand in. A COMPLETE inline citation (has a "]") is left untouched.
 */
export function stripTruncatedCitation(answer: string): string {
  const idx = answer.lastIndexOf("[from");
  if (idx < 0 || answer.indexOf("]", idx) >= 0) return answer;
  return answer.slice(0, idx).trimEnd();
}

/**
 * Strip an inline `[from X]` citation whose X is NOT a source actually placed in
 * the grounding context. The local model invents citations for data it never
 * grounded — "현재 비가 옵니다 [from weather]" with no weather tool call, "[from
 * internet]", "[from memory]" — which fakes the "shows its work" edge: a source
 * marker the user can't trust. Routes through the SAME hardened gate the `ask`
 * path uses (`enforceAnswerCitations`) rather than a second marker-only
 * implementation: a citation naming a real retrieved source (by its
 * notes-relative path, basename, or a paraphrase — tolerant resolution) is kept
 * (rewritten to its canonical short form), and the WHOLE SENTENCE is dropped —
 * not just the marker — when its only citation is fabricated, so a fabricated
 * CLAUSE can never survive uncited as a bare confident assertion (the
 * clause-leak this closes: a marker-only strip left the surrounding invented
 * claim standing). Allowed sources are the SHORT citation refs (matching what
 * the grounding block actually showed the model), never the raw absolute path
 * — a canonical rewrite must never leak the home directory. When every
 * sentence turns out to rest on a fabricated citation, `withUngroundableFallback`
 * surfaces the honest hedge instead of a silently blank answer (parity with the
 * `ask` path's identical fallback after the same gate).
 */
export function stripFabricatedCitations(answer: string, sources: readonly string[]): string {
  if (!answer.includes("[from ")) return answer;
  return withUngroundableFallback(enforceAnswerCitations(answer, { notes: sources.map(shortCitationRef) }));
}

/**
 * Post-gate strips for a chat answer, mirroring the ask path: remove any
 * grounding-block FENCE tag the model echoed (`<<memory N — label>>`, `<<note
 * …>>`, `<<end>>`) so an internal context marker never leaks to the user, an
 * echoed "cite as" citation INSTRUCTION the model parroted, plus truncated and
 * fabricated citations. Ask already applies all of these (commands-ask
 * post-stream); this brings chat to parity in the SHARED finalizer.
 */
export function stripChatAnswerArtifacts(answer: string, sources: readonly string[]): string {
  return stripFabricatedCitations(stripEchoedCiteAs(stripGroundingFences(stripTruncatedCitation(answer))), sources);
}

/** Append a "shows its work" source receipt when chat answered FROM the user's
 * notes — the model often forgets to render [from <source>] inline, but the
 * "answers from your notes, source quoted" promise should still be visible. */
export function withGroundingReceipt(
  answer: string,
  sources: readonly string[],
  korean: boolean,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (sources.length === 0 || isChatAbstention(answer) || expressesNoInformation(answer) || answer.includes("[from")) return answer;
  const label = korean ? "노트" : "from";
  let receipt = `${answer}\n\n📎 ${label}: ${sources.join(", ")}`;
  // POSITIVE corroboration signal (default-on, parity with the ask wedge): a claim
  // backed by ≥2 INDEPENDENT sources is the realistic local-first hedge against
  // GROUNDED≠TRUE (a single poisoned/stale note can't fake independent agreement).
  // Non-noisy — fires only on the multi-source minority, rewards corroboration
  // rather than penalizing a legitimately single-source fact.
  receipt += corroborationReceiptLine(sources, korean);
  // Quorum hedge (A2, biology — Becker et al. 2022/2023): when the answer rests
  // on a SINGLE independent witness source, honestly acknowledge it isn't
  // corroborated. Opt-in (`MUSE_QUORUM_HEDGE=1`) and default-off, because most
  // personal facts legitimately live in one note — hedging every one would be
  // noise; this never refuses, it only labels confidence.
  if (parseBooleanFromEnv(env.MUSE_QUORUM_HEDGE, false) && quorumVerdict(independentWitnessCount(sources)) === "single") {
    receipt += korean
      ? "\n(노트 한 곳에만 근거한 답이에요 — 최신인지 확인해 주세요.)"
      : "\n(Based on a single note — double-check it's current.)";
  }
  return receipt;
}
