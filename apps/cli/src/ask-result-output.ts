/**
 * Machine-surface + run-log output helpers for `muse ask`: the decomposition
 * trust signals (`--json` block + human stderr notes), the stream event/result
 * types, and the stream-failure renderer. Pure where possible so the contracts
 * can be pinned by direct unit tests instead of the inline god-handler.
 */

import type { DecomposedAskResult } from "./ask-decompose.js";

export interface AskStreamEvent {
  readonly type: string;
  readonly text?: string;
  readonly error?: { readonly message?: string };
  readonly response?: { readonly logprobs?: readonly { readonly token: string; readonly logprob: number }[] };
}

export interface AskStreamResult {
  readonly answer: string;
  readonly error?: string;
  /** Observational token logprobs from the done event (MUSE_LOGPROBS=1). */
  readonly logprobs?: readonly { readonly token: string; readonly logprob: number }[];
}

/** A fan-out's trust signals for the `--json` payload + the run-log. */
export interface DecompositionTrustSignals {
  readonly subtaskCount: number;
  readonly truncated: boolean;
  readonly subtaskConflicts?: readonly string[];
  readonly subtaskRedundancies?: readonly string[];
  readonly reasoningActionGaps?: readonly string[];
  readonly synthesisIncomplete?: readonly string[];
}

/**
 * The `decomposition` block for the `muse ask --json` payload: a MACHINE consumer
 * (the whole point of `--json`) can't read the human stderr banner, so a fan-out that
 * CONTRADICTED itself, DROPPED a sub-result, or was TRUNCATED would otherwise reach a
 * script wearing a clean `groundedVerdict:"grounded"` — a GROUNDED≠TRUE leak. Emits the
 * block ONLY for a decomposed run (no noise on the single-run common path); empty signal
 * arrays are omitted. Pure (additive — never touches the answer or the verdict).
 */
export function decompositionJsonFields(
  decomposed: DecomposedAskResult
): { readonly decomposition?: DecompositionTrustSignals } {
  if (!decomposed.decomposed) return {};
  return {
    decomposition: {
      subtaskCount: decomposed.subtaskCount,
      truncated: decomposed.truncated,
      ...(decomposed.subtaskConflicts && decomposed.subtaskConflicts.length > 0 ? { subtaskConflicts: decomposed.subtaskConflicts } : {}),
      ...(decomposed.subtaskRedundancies && decomposed.subtaskRedundancies.length > 0 ? { subtaskRedundancies: decomposed.subtaskRedundancies } : {}),
      ...(decomposed.reasoningActionGaps && decomposed.reasoningActionGaps.length > 0 ? { reasoningActionGaps: decomposed.reasoningActionGaps } : {}),
      ...(decomposed.synthesisIncomplete && decomposed.synthesisIncomplete.length > 0 ? { synthesisIncomplete: decomposed.synthesisIncomplete } : {})
    }
  };
}

/**
 * The human-facing stderr WARNING lines for a decomposed run (pure, so it's testable
 * unlike the inline god-file prints). Surfaces the CORRECTNESS-relevant fan-in signals a
 * `muse ask` user should verify: a cross-sub-task CONTRADICTION (workers disagree), and
 * REDUNDANCY (two sub-answers near-identical → the synthesis may over-weight that point).
 * Deliberately does NOT surface `reasoningActionGaps`: that lexical signal over-fires on
 * legitimate paraphrase/decide downstreams (measured, see lead-worker.ts) — too noisy for a
 * prominent human warning, so it stays in the `--json` payload where a consumer can weight it.
 * Each line is a multi-line block; the caller appends the trailing newline.
 */
export function decompositionStderrNotes(decomposed: DecomposedAskResult): readonly string[] {
  const notes: string[] = [];
  if (decomposed.subtaskConflicts && decomposed.subtaskConflicts.length > 0) {
    notes.push(`⚠️ sub-results disagree — verify before trusting:\n${decomposed.subtaskConflicts.map((c) => `  • ${c}`).join("\n")}`);
  }
  if (decomposed.subtaskRedundancies && decomposed.subtaskRedundancies.length > 0) {
    notes.push(`ℹ sub-tasks produced near-identical results (the answer may over-weight a point):\n${decomposed.subtaskRedundancies.map((c) => `  • ${c}`).join("\n")}`);
  }
  return notes;
}

export function renderAskStreamError(params: {
  readonly json: boolean;
  readonly query: string;
  readonly model: string;
  readonly answer: string;
  readonly error: string;
}): { readonly stdout?: string; readonly stderr?: string } {
  if (params.json) {
    return {
      stdout: `${JSON.stringify(
        { query: params.query, model: params.model, answer: params.answer, error: params.error },
        null,
        2
      )}\n`
    };
  }
  return { stderr: `\n(error: ${params.error})\n` };
}
