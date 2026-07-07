/**
 * CMP-2 — auxiliary-model compaction.
 *
 * When a turn drops old context to fit the window, the deterministic
 * summary (`[Key details]` salient facts) is the FLOOR. This adds an
 * OPTIONAL richer summary produced by a cheap auxiliary model (e.g. a
 * second local Ollama gemma4 call) over the dropped messages, while the
 * main inference model stays on the user's task.
 *
 * Two non-negotiables shape it:
 *  - MODEL-AGNOSTIC: the summarizer is INJECTED (a `(messages) => Promise<string>`),
 *    so agent-core / @muse/memory never reference a vendor SDK (architecture.md).
 *  - FAIL-OPEN to deterministic (CMP-1 principle): a local agent MUST
 *    survive a compression-engine failure. Any throw, timeout-rejection,
 *    or empty/whitespace result falls back to the deterministic summary —
 *    compaction never stalls or loses the floor because the aux model was
 *    slow, down, or returned junk.
 */

import type { ConversationMessage } from "./index.js";

export interface DroppedContextSummarizerOptions {
  /**
   * When set, the summarizer is asked to preserve full detail about this
   * topic while still recording other decisions/facts tersely (hermes'
   * `/compact <focus>` pattern, adapted). A summarizer that ignores it is
   * still valid — the option is advisory, not required.
   */
  readonly focusTopic?: string;
}

export type DroppedContextSummarizer = (
  messages: readonly ConversationMessage[],
  options?: DroppedContextSummarizerOptions
) => Promise<string>;

export interface SummarizeDroppedOptions {
  /** Deterministic summary to use when the aux summarizer is absent or fails. */
  readonly fallback: string;
  /** Optional hard cap on the aux summary length; longer output is truncated. */
  readonly maxChars?: number;
  /** Forwarded verbatim to the summarizer as `DroppedContextSummarizerOptions.focusTopic`. */
  readonly focusTopic?: string;
}

/**
 * Summarize DROPPED context with an aux model, failing open to the
 * deterministic `fallback`. Returns `fallback` when there is no
 * summarizer, nothing was dropped, the summarizer throws, or it yields an
 * empty/whitespace string. A successful summary is trimmed and (if
 * `maxChars` is set) truncated. Pure orchestration — no model coupling.
 */
export async function summarizeDroppedContext(
  dropped: readonly ConversationMessage[],
  summarizer: DroppedContextSummarizer | undefined,
  options: SummarizeDroppedOptions
): Promise<string> {
  if (!summarizer || dropped.length === 0) {
    return options.fallback;
  }
  try {
    const raw = await summarizer(dropped, options.focusTopic ? { focusTopic: options.focusTopic } : undefined);
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed.length === 0) {
      return options.fallback;
    }
    return options.maxChars !== undefined && options.maxChars > 0 && trimmed.length > options.maxChars
      ? trimmed.slice(0, options.maxChars)
      : trimmed;
  } catch {
    return options.fallback;
  }
}
