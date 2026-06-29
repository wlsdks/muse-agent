/**
 * LLM parallel decomposer — the SOURCE the board's parallel mode needs. The deterministic
 * decomposeRequest only ever produces sequential 2-step splits; a real fan-out ("compare A, B,
 * C" → research-A ∥ research-B ∥ research-C → synthesize) needs a model to recognise INDEPENDENT
 * sub-work. This asks the model for exactly that, with a deterministic parser as the contract so
 * the parse is unit-tested and the model call is the only non-deterministic part.
 */

export function parallelDecomposePrompt(goal: string): string {
  return [
    "Break this goal into 2-5 INDEPENDENT sub-tasks that can run in PARALLEL —",
    "no sub-task may depend on another's result. Output ONLY the sub-tasks, one per line,",
    "with NO numbering or commentary. If the goal is a single task, or its steps MUST be",
    "done in order (one needs an earlier one's result), output exactly: NONE",
    "",
    `GOAL: ${goal}`
  ].join("\n");
}

/**
 * Parse the model's reply into independent sub-task titles. Strips list markers (`1.`, `-`, `*`),
 * drops blanks, and returns [] for a refusal ("NONE") or a non-decomposition (<2 lines) — so a
 * single task or a sequential goal never gets force-split into a bad parallel fan-out.
 */
export function parseParallelPlan(output: string): string[] {
  const lines = output
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "").trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0 || lines.some((l) => /^none\.?$/iu.test(l))) return [];
  return lines.length >= 2 ? lines : [];
}

export interface ParallelDecomposeDeps {
  /** One-shot text completion (the CLI wires this to the local/cloud model provider). */
  readonly generate: (prompt: string) => Promise<string>;
}

/** Ask the model to split `goal` into independent parallel sub-tasks ([] if it shouldn't be). */
export async function planParallelSubtasks(goal: string, deps: ParallelDecomposeDeps): Promise<string[]> {
  const output = await deps.generate(parallelDecomposePrompt(goal));
  return parseParallelPlan(output);
}
