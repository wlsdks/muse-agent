export interface DecomposeSignals {
  readonly enumeration: number;
  readonly sequencing: number;
  readonly broadScope: boolean;
  readonly synthesis: boolean;
}

export interface DecomposeDecision {
  readonly decompose: boolean;
  readonly signals: DecomposeSignals;
  readonly reason: string;
}

const SEQUENCING_SIGNALS = [
  "먼저", "그 다음", "그다음", "그리고 나서", "그러고 나서", "한 뒤", "한 후", "이후에",
  "then ", "after that", "next,", "first,", "finally", "lastly", "step 1", "step 2"
] as const;

const BROAD_SCOPE_SIGNALS = [
  "전부", "모두", "모든", "전체", "각각", "각 ", "싹 다",
  " all ", " every ", "each of", "entire", "across all", "everything"
] as const;

const SYNTHESIS_SIGNALS = [
  "보고서", "리포트", "요약해", "요약 ", "정리해", "정리 ", "종합",
  "report", "summary", "summarize", "summarise", "synthesize", "synthesise", "compile"
] as const;

const NUMBERED_ITEM = /(?:^|\s)\d+[.)]\s/g;
const BULLET_ITEM = /(?:^|\n)\s*[-*•]\s/g;

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function countSignals(haystack: string, signals: readonly string[]): number {
  let n = 0;
  for (const signal of signals) {
    if (haystack.includes(signal)) n += 1;
  }
  return n;
}

/**
 * Deterministic trigger for lead-worker decomposition. A request earns a
 * fan-out to sub-agents ONLY when it carries an explicit multi-item list, a
 * genuine multi-step sequence, or a broad-scope aggregation ("전부 …
 * 보고서") — decomposing a simple ask wastes N× wall-clock on a single GPU,
 * so the bias is STRONGLY toward single-agent: a lone signal never triggers.
 * Korean-first signals (Muse) plus English. The thresholds are intentionally
 * conservative here and meant to be tuned against the live ask distribution
 * once wired (slice 2).
 */
export function shouldDecompose(request: string): DecomposeDecision {
  const normalized = request.toLowerCase();

  const signals: DecomposeSignals = {
    broadScope: countSignals(normalized, BROAD_SCOPE_SIGNALS) > 0,
    enumeration: countMatches(request, NUMBERED_ITEM) + countMatches(request, BULLET_ITEM),
    sequencing: countSignals(normalized, SEQUENCING_SIGNALS),
    synthesis: countSignals(normalized, SYNTHESIS_SIGNALS) > 0
  };

  if (signals.enumeration >= 3) {
    return { decompose: true, reason: `explicit list of ${signals.enumeration} items`, signals };
  }
  if (signals.sequencing >= 2) {
    return { decompose: true, reason: `${signals.sequencing} ordered multi-step markers`, signals };
  }
  if (signals.broadScope && signals.synthesis) {
    return { decompose: true, reason: "broad-scope aggregation (scope quantifier + synthesis ask)", signals };
  }

  return { decompose: false, reason: "no multi-task shape — single-agent (fail to no-decompose)", signals };
}

export interface Subtask {
  readonly id: string;
  readonly text: string;
}

const SEQUENCING_SPLIT =
  /먼저|그 다음|그다음|그리고 나서|그러고 나서|한 뒤|한 후|이후에|then |after that|next,|first,|finally|lastly/gi;

function toSubtasks(texts: readonly string[]): readonly Subtask[] {
  return texts.map((text, index) => ({ id: `subtask_${index + 1}`, text }));
}

function extractNumberedItems(request: string): string[] {
  const parts = request.split(/(?:^|\s)\d+[.)]\s+/);
  if (parts.length < 2) return [];
  return parts
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractBulletItems(request: string): string[] {
  return request
    .split("\n")
    .map((line) => line.match(/^\s*[-*•]\s+(.*)$/))
    .map((match) => match?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function extractSequencedSteps(request: string): string[] {
  return request
    .split(SEQUENCING_SPLIT)
    .map((part) => part.trim().replace(/^[,:、]\s*/, "").trim())
    .filter(Boolean);
}

export interface DecomposedRequest {
  readonly subtasks: readonly Subtask[];
  /**
   * `true` iff the split came from an ORDERED sequence ("먼저 … 그 다음 …" /
   * "first … then …") — later steps may operate on an earlier step's RESULT, so
   * the engine threads prior outputs forward. A numbered/bulleted list is
   * `false` (independent items run in isolation). Distinguishing them is what
   * stops a sequenced step 2 from running blind (MAST reasoning-action mismatch).
   */
  readonly sequenced: boolean;
}

/**
 * Deterministic structural decomposition: pull sub-tasks out of a
 * numbered/bulleted list (INDEPENDENT) or an ordered multi-step sequence
 * (SEQUENCED — later steps may depend on earlier output). Returns ONE sub-task
 * (the whole request) when no structure is present — a broad-scope aggregation
 * ("내 노트 전부 … 보고서") has no literal split, so it falls back to single and
 * the engine asks an injected model planner to split it.
 */
export function decomposeRequestWithKind(request: string): DecomposedRequest {
  const numbered = extractNumberedItems(request);
  if (numbered.length >= 2) return { sequenced: false, subtasks: toSubtasks(numbered) };

  const bullets = extractBulletItems(request);
  if (bullets.length >= 2) return { sequenced: false, subtasks: toSubtasks(bullets) };

  const steps = extractSequencedSteps(request);
  if (steps.length >= 2) return { sequenced: true, subtasks: toSubtasks(steps) };

  return { sequenced: false, subtasks: [{ id: "subtask_1", text: request.trim() }] };
}

/** Back-compat thin wrapper — the sub-tasks only (callers needing the sequenced
 *  flag use {@link decomposeRequestWithKind}). */
export function decomposeRequest(request: string): readonly Subtask[] {
  return decomposeRequestWithKind(request).subtasks;
}
