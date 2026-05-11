/**
 * Prompt Budget Orchestrator (iter 17, cross-cutting).
 *
 * Each Context Engineering transform (Phase 1-7) lands a section
 * in the first system message under a `<!-- muse:{sectionId} -->`
 * marker. Individual transforms already cap their own output, but
 * nothing measured the *combined* footprint until now: a turn
 * with active context + inbox + episodic + attachments + skills +
 * user memory + prompt-layers all firing can spend 5-10K tokens on
 * the system prompt alone, and nobody saw the breakdown.
 *
 * This module:
 *   1. Parses the first system message back into its sections by
 *      walking the `<!-- muse:{id} -->` markers (same format
 *      `appendSystemSection` emits).
 *   2. Measures char count + an approximate token count per section
 *      using `@muse/memory`'s `computeApproximateTokens`.
 *   3. Surfaces the report so AgentRuntime can stamp it onto the
 *      trace span — `ctx.budget.section.<id>.tokens` etc. — so
 *      observability dashboards can answer "what's eating my
 *      prompt budget?" without guessing.
 *
 * The orchestrator is read-only today: it MEASURES, does not yet
 * drop low-priority sections. Drop semantics can layer on later
 * once we have real production data on which sections most often
 * outgrow their share.
 */

import { computeApproximateTokens } from "@muse/memory";
import type { ModelMessage } from "@muse/model";

export interface PromptBudgetSection {
  readonly id: string;
  readonly chars: number;
  readonly estimatedTokens: number;
}

export interface PromptBudgetReport {
  readonly totalChars: number;
  readonly totalEstimatedTokens: number;
  /** Char count of the system message portion BEFORE any tracked section. */
  readonly preludeChars: number;
  readonly sections: readonly PromptBudgetSection[];
}

const MARKER_PATTERN = /<!--\s*muse:([\w-]+)\s*-->/gu;

/**
 * Measure the system-prompt budget across all Muse-managed sections.
 * Reads the FIRST system message (the convention every transform
 * appends to). Returns `undefined` when there's no system message
 * — the caller can treat that as "nothing to measure".
 */
export function measureSystemPromptBudget(
  messages: readonly ModelMessage[]
): PromptBudgetReport | undefined {
  const systemMessage = messages.find((message) => message.role === "system");
  if (!systemMessage) {
    return undefined;
  }
  return measureSystemPromptText(systemMessage.content);
}

export function measureSystemPromptText(systemContent: string): PromptBudgetReport {
  const matches = [...systemContent.matchAll(MARKER_PATTERN)];
  const sections: PromptBudgetSection[] = [];
  if (matches.length === 0) {
    return {
      preludeChars: systemContent.length,
      sections,
      totalChars: systemContent.length,
      totalEstimatedTokens: computeApproximateTokens(systemContent)
    };
  }
  const firstMarkerStart = matches[0]?.index ?? 0;
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    if (!match || match.index === undefined) continue;
    const id = match[1] ?? "unknown";
    const sectionStart = match.index;
    const next = matches[i + 1];
    const sectionEnd = next?.index ?? systemContent.length;
    const sectionText = systemContent.slice(sectionStart, sectionEnd);
    sections.push({
      chars: sectionText.length,
      estimatedTokens: computeApproximateTokens(sectionText),
      id
    });
  }
  return {
    preludeChars: firstMarkerStart,
    sections,
    totalChars: systemContent.length,
    totalEstimatedTokens: computeApproximateTokens(systemContent)
  };
}

/**
 * Flatten the report into a flat record so it can be stamped onto a
 * trace span attribute set. Keys:
 *   - `ctx.budget.total_chars`
 *   - `ctx.budget.total_tokens`
 *   - `ctx.budget.prelude_chars`
 *   - `ctx.budget.section.<id>.chars`
 *   - `ctx.budget.section.<id>.tokens`
 */
export function promptBudgetSpanAttributes(
  report: PromptBudgetReport
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {
    "ctx.budget.prelude_chars": report.preludeChars,
    "ctx.budget.total_chars": report.totalChars,
    "ctx.budget.total_tokens": report.totalEstimatedTokens
  };
  for (const section of report.sections) {
    out[`ctx.budget.section.${section.id}.chars`] = section.chars;
    out[`ctx.budget.section.${section.id}.tokens`] = section.estimatedTokens;
  }
  return out;
}
