import { lexicalOverlap, lexicalTokens } from "./knowledge-recall.js";

/**
 * Few-shot tool exemplars: 2-3 semantically similar PAST requests and the tool
 * that correctly handled them, injected as a system section so a small local
 * model imitates a proven selection instead of reasoning from scratch
 * (LangChain measured tool-calling 16%→52% with 3 similar exemplars; arXiv
 * 2508.15214). `tool: null` exemplars teach restraint — the no-tool cases that
 * keep IrrelAcc from degrading when exemplars bias the model toward firing.
 */
export interface ToolExemplar {
  readonly prompt: string;
  /** The tool that handled it, or null when the right behavior was NO tool. */
  readonly tool: string | null;
}

/**
 * Deterministic lexical ranking (no model, no embeddings): overlap > 0 keeps
 * the exemplar, ties resolve in bank order. Embedding similarity can slot in
 * later behind the same signature once the trace-extracted bank is large
 * enough to need it.
 */
export function selectToolExemplars(
  query: string,
  bank: readonly ToolExemplar[],
  k: number
): ToolExemplar[] {
  const queryTokens = lexicalTokens(query);
  const scored = bank
    .map((exemplar, index) => ({ exemplar, index, overlap: lexicalOverlap(queryTokens, exemplar.prompt) }))
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => (b.overlap - a.overlap) || (a.index - b.index));
  const cap = Math.max(0, Math.trunc(k));
  const top = scored.slice(0, cap);
  // Restraint representation (IrrelAcc): few-shot exemplars bias the model
  // toward FIRING, and the `tool: null` cases exist to counter that — but a pure
  // top-k by similarity can crowd every no-tool case out, leaving an
  // all-positive block that over-fires on a lookalike query. When the selection
  // is full, has no no-tool exemplar, yet a RELEVANT (overlap>0) one exists,
  // swap the weakest positive for the best relevant no-tool case — keeping ≥1
  // positive so the strongest match is never displaced.
  if (cap >= 2 && top.length === cap && !top.some((entry) => entry.exemplar.tool === null)) {
    const bestNull = scored.find((entry) => entry.exemplar.tool === null && !top.includes(entry));
    if (bestNull) {
      top[top.length - 1] = bestNull;
    }
  }
  return top.map((entry) => entry.exemplar);
}

export function renderToolExemplarSection(exemplars: readonly ToolExemplar[]): string {
  if (exemplars.length === 0) {
    return "";
  }
  const lines = exemplars.map((exemplar) =>
    `- "${exemplar.prompt}" → ${exemplar.tool ?? "(no tool — answered directly)"}`
  );
  return [
    "Past requests and the tool that correctly handled each (follow the same pattern; when the pattern says no tool, do not call one):",
    ...lines
  ].join("\n");
}
