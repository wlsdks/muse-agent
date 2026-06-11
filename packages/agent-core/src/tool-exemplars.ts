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
  return bank
    .map((exemplar, index) => ({ exemplar, index, overlap: lexicalOverlap(queryTokens, exemplar.prompt) }))
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => (b.overlap - a.overlap) || (a.index - b.index))
    .slice(0, Math.max(0, k))
    .map((entry) => entry.exemplar);
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
