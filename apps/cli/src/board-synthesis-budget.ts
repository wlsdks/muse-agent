/**
 * Bounds the board's synthesis prompt (`boardTaskPrompt`'s `dependencyOutputs` branch) so
 * N completed sub-task outputs never blow the model's context window. Each child gets a
 * budget proportional to the available headroom; anything over budget is truncated in the
 * prompt and the FULL text is spilled to a file, so nothing is lost — only the prompt shrinks.
 * Pure helpers here; the caller (the board executor) injects the file write so this stays
 * unit-testable without touching disk.
 */

import { join } from "node:path";

/** Never below this many characters, even with many children or a small headroom. */
export const SYNTHESIS_PER_CHILD_FLOOR = 2000;

/**
 * Per-child character budget: half the headroom split evenly across children, floored so a
 * single child never gets squeezed to nothing. Guards `childCount <= 0` (no divide-by-zero)
 * and a non-finite/non-positive `headroom` — both fall back to the floor.
 */
export function perChildSynthesisBudget(headroom: number, childCount: number): number {
  if (childCount <= 0 || !Number.isFinite(headroom) || headroom <= 0) return SYNTHESIS_PER_CHILD_FLOOR;
  return Math.max(SYNTHESIS_PER_CHILD_FLOOR, Math.floor((headroom * 0.5) / childCount));
}

/** Character-based budget (the prompt is text, not tokens — a cheap, dependency-free proxy). */
export function budgetChildOutput(output: string, budget: number): { readonly kept: string; readonly overflow: boolean } {
  if (output.length <= budget) return { kept: output, overflow: false };
  return { kept: output.slice(0, budget), overflow: true };
}

export interface BudgetAndSpillOptions {
  readonly headroom: number;
  readonly spillDir: string;
  readonly writeSpill: (path: string, content: string) => void;
  readonly makeName: (index: number) => string;
}

export interface BudgetAndSpillResult {
  readonly segments: readonly string[];
  readonly spills: readonly { readonly index: number; readonly path: string }[];
}

/**
 * Budgets every child output for the synthesis prompt; an over-budget child is truncated in
 * its segment AND spilled in full to `spillDir` via the injected writer, with the segment
 * referencing the spill path so the model (and a human reading `board show`) can find it.
 */
export function budgetAndSpillOutputs(outputs: readonly string[], opts: BudgetAndSpillOptions): BudgetAndSpillResult {
  const budget = perChildSynthesisBudget(opts.headroom, outputs.length);
  const segments: string[] = [];
  const spills: { readonly index: number; readonly path: string }[] = [];
  outputs.forEach((output, index) => {
    const { kept, overflow } = budgetChildOutput(output, budget);
    if (!overflow) { segments.push(output); return; }
    const path = join(opts.spillDir, opts.makeName(index));
    opts.writeSpill(path, output);
    spills.push({ index, path });
    segments.push(`${kept}\n…[truncated — full output spilled to ${path}]`);
  });
  return { segments, spills };
}

/** The note appended to a synthesis answer so the user knows where the full sub-task text lives. */
export function formatSpillNote(spillCount: number, spillDir: string): string {
  if (spillCount <= 0) return "";
  return `\n\n(${spillCount.toString()} sub-task output(s) too large for this summary were saved in full to ${spillDir})`;
}
