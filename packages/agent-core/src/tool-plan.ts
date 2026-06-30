/**
 * Programmatic Tool Calling (PTC) — the PURE plan schema + DAG interpreter (no model, no
 * AgentRuntime). A local ~12B model degrades on multi-step tool chains: coherence drops after 2–3
 * inference rounds and every intermediate tool result floods a small context window. PTC lets the
 * model emit, in ONE inference, a typed PLAN — ordered tool steps whose args may reference a prior
 * step's output by a `$binding` — which Muse executes deterministically; only the projected result
 * re-enters the model's context. This module is Phase 1: parse + validate + execute against a
 * pluggable executor seam, so Phase 2 can wire that seam to AgentRuntime's gated tool path.
 *
 * Design + hostile review: docs/strategy/programmatic-tool-calling.md. Source mirror:
 * hermes-agent tools/code_execution_tool.py (MIT/Apache) — pattern, plan-first reimplementation
 * (NO arbitrary code execution: the plan is a closed, interpreted schema, not `eval`).
 */

import { isRecord, type JsonObject } from "@muse/shared";

export interface ToolPlanStep {
  /** Binding name this step's output is stored under, referenceable by LATER steps as `$as`. */
  readonly as: string;
  /** A registered tool name (validated against the known-tool set at parse time). */
  readonly tool: string;
  /** Arguments; a value that is EXACTLY a `$binding`/`$binding.path` string is substituted with a
   * prior step's output (data binding only — never re-parsed as plan/instructions). */
  readonly args: JsonObject;
}

export interface ToolPlan {
  readonly steps: readonly ToolPlanStep[];
  /** Projection that selects what re-enters the model's context — a `$binding` or `$binding.path`. */
  readonly result: string;
}

export interface ToolPlanStepOutput {
  readonly as: string;
  readonly tool: string;
  readonly output: unknown;
}

export interface ToolPlanResult {
  /** The projected value returned to the model (only this leaves the plan). */
  readonly result: unknown;
  /** Every step's raw output IN ORDER — kept out of the model context, but available to Phase 3's
   * grounding wiring so the final answer stays citable (fabrication=0 preserved). */
  readonly steps: readonly ToolPlanStepOutput[];
}

/** Executes one resolved tool call. Phase 2 binds this to AgentRuntime's gated path (approval +
 * arg-grounding); Phase 1 tests pass a fake. Throwing aborts the plan (no partial side effects). */
export type ToolPlanExecutor = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export const DEFAULT_MAX_PLAN_STEPS = 16;

// A whole-value reference: the ENTIRE arg/result string is `$binding` or `$binding.seg.seg`. A
// string that merely contains `$` (or interpolates a ref mid-text) is a literal — substitution is
// value-level only, which is also the injection guard (a ref value is never spliced into text).
// `$binding`, `$binding.path.path`, optionally piped through ONE pure projection
// (`$hits | count`, `$results.items | first`). Transforms keep a result concise — e.g. a search
// step returning 100 rows can project `$rows | count` so a huge array never re-enters the context.
// The transform set is CLOSED (count/first/last) — a fixed keyword, never arbitrary code.
const REF_RE = /^\$([A-Za-z_][\w]*)((?:\.[\w]+)*)(?:\s*\|\s*(count|first|last))?$/u;

type Transform = "count" | "first" | "last";

interface ParsedRef {
  readonly binding: string;
  readonly path: readonly string[];
  readonly transform?: Transform;
}

function parseRef(value: string): ParsedRef | undefined {
  const m = REF_RE.exec(value);
  if (!m) return undefined;
  const path = m[2] ? m[2].split(".").filter((s) => s.length > 0) : [];
  return { binding: m[1]!, path, ...(m[3] ? { transform: m[3] as Transform } : {}) };
}

// Apply a closed-set projection to a resolved value. count → array length (0/1 for a non-array,
// matching "how many"); first/last → the end element (the value itself when not an array).
function applyTransform(value: unknown, transform: Transform | undefined): unknown {
  if (transform === undefined) return value;
  if (transform === "count") return Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1;
  if (Array.isArray(value)) return transform === "first" ? value[0] : value[value.length - 1];
  return value;
}

// Resolve a ref against the bindings: pick the path, then apply any transform — the single seam
// both arg substitution and the result projection share.
function resolveRef(ref: ParsedRef, bindings: ReadonlyMap<string, unknown>): unknown {
  return applyTransform(getPath(bindings.get(ref.binding), ref.path), ref.transform);
}

function refsInArgs(args: Record<string, unknown>): ParsedRef[] {
  const out: ParsedRef[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === "string") {
      const ref = parseRef(value);
      if (ref) out.push(ref);
    }
  }
  return out;
}

export interface ParseToolPlanOptions {
  /** When given, a step whose `tool` is not in this set is a parse error (no fabricated tools). */
  readonly knownTools?: ReadonlySet<string>;
  readonly maxSteps?: number;
}

/**
 * Parse + validate a raw plan. Deterministic, never throws — returns `{ error }` on any violation:
 * shape, step cap, duplicate binding, unknown tool, and (the cycle guard) a `$`-ref that does not
 * resolve to an EARLIER step. Because refs may only point backward, a plan is acyclic by
 * construction — there is no loop primitive in v1.
 */
export function parseToolPlan(raw: unknown, options: ParseToolPlanOptions = {}): ToolPlan | { error: string } {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_PLAN_STEPS;
  if (!isRecord(raw)) return { error: "plan must be an object" };
  const steps = raw.steps;
  const result = raw.result;
  if (!Array.isArray(steps) || steps.length === 0) return { error: "plan.steps must be a non-empty array" };
  if (steps.length > maxSteps) return { error: `plan.steps exceeds the ${maxSteps.toString()}-step cap` };
  if (typeof result !== "string" || result.trim().length === 0) return { error: "plan.result must be a non-empty string" };

  const priorBindings = new Set<string>();
  const parsedSteps: ToolPlanStep[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const rawStep: unknown = steps[i];
    if (!isRecord(rawStep)) return { error: `step ${i.toString()} must be an object` };
    const as = rawStep.as;
    const tool = rawStep.tool;
    const args = rawStep.args ?? {};
    if (typeof as !== "string" || as.trim().length === 0) return { error: `step ${i.toString()}: 'as' must be a non-empty string` };
    if (priorBindings.has(as)) return { error: `step ${i.toString()}: duplicate binding name '${as}'` };
    if (typeof tool !== "string" || tool.trim().length === 0) return { error: `step ${i.toString()}: 'tool' must be a non-empty string` };
    if (options.knownTools && !options.knownTools.has(tool)) return { error: `step ${i.toString()}: unknown tool '${tool}'` };
    if (!isRecord(args)) return { error: `step ${i.toString()}: 'args' must be an object` };
    for (const ref of refsInArgs(args)) {
      if (!priorBindings.has(ref.binding)) {
        return { error: `step ${i.toString()}: arg ref '$${ref.binding}' does not resolve to an earlier step` };
      }
    }
    priorBindings.add(as);
    parsedSteps.push({ args: args as JsonObject, as, tool });
  }

  const resultRef = parseRef(result.trim());
  if (!resultRef || !priorBindings.has(resultRef.binding)) {
    return { error: `plan.result '${result}' must reference a step binding (e.g. '$${parsedSteps[parsedSteps.length - 1]!.as}')` };
  }
  return { result: result.trim(), steps: parsedSteps };
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const seg of path) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      cursor = Number.isInteger(idx) ? cursor[idx] : undefined;
    } else if (isRecord(cursor)) {
      cursor = cursor[seg];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function resolveArgs(args: Record<string, unknown>, bindings: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const ref = parseRef(value);
      if (ref) {
        out[key] = resolveRef(ref, bindings);
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Execute a validated plan against `executor`, IN ORDER. Each step's `$`-ref args are substituted
 * with prior outputs (value-level, never text-spliced), the tool is run, and its output is bound.
 * Intermediate outputs are returned in `steps` (for grounding) but the `result` projection is what
 * a caller hands back to the model. A thrown executor aborts the plan immediately — no further
 * steps run, so a denied/failed step leaves no partial downstream effect.
 */
export async function executeToolPlan(plan: ToolPlan, executor: ToolPlanExecutor): Promise<ToolPlanResult> {
  const bindings = new Map<string, unknown>();
  const stepOutputs: ToolPlanStepOutput[] = [];
  for (const step of plan.steps) {
    const output = await executor(step.tool, resolveArgs(step.args, bindings));
    bindings.set(step.as, output);
    stepOutputs.push({ as: step.as, output, tool: step.tool });
  }
  return { result: resolveRef(parseRef(plan.result)!, bindings), steps: stepOutputs };
}
