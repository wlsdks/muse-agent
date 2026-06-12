/**
 * Prompt Budget Orchestrator.
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

/**
 * Priority order for budget eviction — HIGHER stays longer. Time/persona and
 * the learned-strategy blocks are load-bearing for correctness; feeds/ambient
 * are flavor. Unknown sections sit in the middle so a new transform is never
 * silently most-evictable.
 */
const SECTION_PRIORITY: Readonly<Record<string, number>> = {
  "active-context": 100,
  "user-memory": 90,
  playbook: 80,
  "veto-avoidance": 75,
  attachments: 70,
  "episodic-recall": 60,
  skills: 50,
  inbox: 40,
  ambient: 30,
  feeds: 20
};
const DEFAULT_SECTION_PRIORITY = 55;

export interface PromptBudgetEnforcement {
  readonly messages: readonly ModelMessage[];
  readonly dropped: readonly PromptBudgetSection[];
}

/**
 * The meter's missing half: when the combined section footprint exceeds
 * `maxTokens`, evict whole sections lowest-priority-first until the prompt
 * fits. The prelude (core instructions before any marker) is never touched.
 * Deterministic, fail-open: no system message / no sections ⇒ unchanged.
 */
export function enforceSystemPromptBudget(
  messages: readonly ModelMessage[],
  options: { readonly maxTokens: number }
): PromptBudgetEnforcement {
  // A non-finite / non-positive budget (a NaN from a bad config parse, say) must
  // NOT silently strip every injected section: `total <= NaN` is always false,
  // so the eviction loop would drop ALL of memory/playbook/active-context. Treat
  // an unusable budget as "no enforcement" (fail-safe — keep the context).
  if (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0) {
    return { dropped: [], messages };
  }
  const report = measureSystemPromptBudget(messages);
  if (!report || report.totalEstimatedTokens <= options.maxTokens || report.sections.length === 0) {
    return { dropped: [], messages };
  }
  const byPriority = [...report.sections].sort((a, b) =>
    (SECTION_PRIORITY[a.id] ?? DEFAULT_SECTION_PRIORITY) - (SECTION_PRIORITY[b.id] ?? DEFAULT_SECTION_PRIORITY)
  );
  const dropIds = new Set<string>();
  const dropped: PromptBudgetSection[] = [];
  let total = report.totalEstimatedTokens;
  for (const candidate of byPriority) {
    if (total <= options.maxTokens) break;
    dropIds.add(candidate.id);
    dropped.push(candidate);
    total -= candidate.estimatedTokens;
  }
  if (dropped.length === 0) {
    return { dropped: [], messages };
  }
  const systemIndex = messages.findIndex((message) => message.role === "system");
  const content = String(messages[systemIndex]!.content);
  // Rebuild: walk markers, keep prelude + surviving sections in order.
  const marker = /<!--\s*muse:([\w-]+)\s*-->/gu;
  const pieces: { id?: string; start: number }[] = [{ start: 0 }];
  for (const match of content.matchAll(marker)) {
    pieces.push({ id: match[1], start: match.index });
  }
  let rebuilt = "";
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!;
    const end = pieces[index + 1]?.start ?? content.length;
    if (piece.id === undefined || !dropIds.has(piece.id)) {
      rebuilt += content.slice(piece.start, end);
    }
  }
  const next = messages.map((message, index) =>
    index === systemIndex ? { ...message, content: rebuilt.trimEnd() } : message
  );
  return { dropped, messages: next };
}
