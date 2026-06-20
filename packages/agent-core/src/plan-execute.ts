import type { ModelMessage, ModelTool } from "@muse/model";
import { isRecord, type JsonObject, type JsonValue } from "@muse/shared";
import { coerceToolArguments, coerceEnumArguments, validateRequiredToolArguments } from "@muse/tools";

import { neutralizeInjectionSpans } from "./injection.js";
import { extractFirstJsonArray, iterateJsonArrayCandidates } from "./json-array-scan.js";

/**
 * Plan-Execute primitives: types, parsing, validation, and the typed errors
 * the PlanExecute strategy raises. Extracted from the agent-core monolith so
 * downstream packages and tests can import the types without pulling the
 * full AgentRuntime surface.
 */

export interface PlanStep {
  readonly tool: string;
  readonly args: JsonObject;
  readonly description: string;
}

/**
 * JSON Schema for the plan (native structured output where supported → the
 * local model is constrained to a `{tool,args,description}[]` array, not
 * free text scanned by extractJsonArray). `tool` is the only hard requirement;
 * args/description default in toPlanSteps. extractJsonArray stays the fallback.
 */
export const PLAN_RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      tool: { type: "string" },
      args: { type: "object" },
      description: { type: "string" }
    },
    required: ["tool"]
  }
} as const;

export interface PlanValidationError {
  readonly stepIndex: number;
  readonly tool: string;
  readonly reason: string;
}

export interface PlanValidationResult {
  readonly valid: boolean;
  readonly steps: readonly PlanStep[];
  readonly errors: readonly PlanValidationError[];
}

export interface StepExecutionResult {
  readonly tool: string;
  readonly description: string;
  readonly output: string | null;
  readonly success: boolean;
  readonly error?: string;
}

export class PlanValidationFailedError extends Error {
  readonly errors: readonly PlanValidationError[];
  readonly steps: readonly PlanStep[];

  constructor(errors: readonly PlanValidationError[], steps: readonly PlanStep[] = []) {
    super(errors.map((entry) => `step ${entry.stepIndex + 1}: ${entry.reason}`).join("; "));
    this.name = "PlanValidationFailedError";
    this.errors = errors;
    this.steps = steps;
  }
}

export type PlanExecutionErrorCode =
  | "PLAN_GENERATION_FAILED"
  | "PLAN_ALL_STEPS_FAILED"
  | "RESPONSE_SYNTHESIS_FAILED";

export class PlanExecutionError extends Error {
  readonly code: PlanExecutionErrorCode;

  constructor(code: PlanExecutionErrorCode, message: string) {
    super(message);
    this.name = "PlanExecutionError";
    this.code = code;
  }
}

/**
 * Returns the substring of the first balanced `[ … ]` span that parses as a
 * JSON array, or `null`. See `json-array-scan` for why anchoring on the
 * literal first `[` is unsafe against the local model's prose.
 */
export function extractJsonArray(text: string): string | null {
  return extractFirstJsonArray(text);
}

/**
 * Parses an LLM response into a plan. Walks the JSON-array candidates in
 * `text` and returns the first NON-EMPTY array whose every entry is a valid
 * step (object with a string `tool`, optional object `args`). A lone empty
 * array is the (valid) empty plan, but an empty `[ ]` in prose — e.g. a
 * markdown `- [ ]` checkbox — never shadows a real plan that follows it.
 * Returns `null` when no candidate parses to a plan and no empty array was
 * seen.
 */
export function parsePlan(text: string): readonly PlanStep[] | null {
  let sawEmptyArray = false;
  for (const candidate of iterateJsonArrayCandidates(text)) {
    if (candidate.value.length === 0) {
      sawEmptyArray = true;
      continue;
    }
    const steps = toPlanSteps(candidate.value);
    if (steps !== null) {
      return steps;
    }
  }
  return sawEmptyArray ? [] : null;
}

function toPlanSteps(entries: readonly unknown[]): readonly PlanStep[] | null {
  const steps: PlanStep[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const toolValue = record["tool"];
    const argsValue = record["args"];
    const descriptionValue = record["description"];
    if (typeof toolValue !== "string") {
      return null;
    }
    if (argsValue !== undefined && (argsValue === null || typeof argsValue !== "object" || Array.isArray(argsValue))) {
      return null;
    }
    steps.push({
      args: (argsValue as JsonObject | undefined) ?? {},
      description: typeof descriptionValue === "string" ? descriptionValue : "",
      tool: toolValue
    });
  }
  return steps;
}

export interface PlanValidationInput {
  readonly steps: readonly PlanStep[];
  readonly availableToolNames: ReadonlySet<string>;
  /**
   * When supplied (built from `request.tools`), each registered step's args
   * are coerced then validated for missing required fields — catching "later
   * step missing a required arg" BEFORE execution starts and eliminating
   * partial side-effects (τ-bench no-partial-side-effects property).
   * ISR-LLM (arXiv:2308.13724): validate before execute, feed errors back for
   * one bounded repair round. Absent → byte-identical to prior behaviour.
   */
  readonly toolSchemas?: ReadonlyMap<string, JsonValue>;
  /**
   * ISR-LLM (arXiv:2308.13724) precondition check: when supplied, write/execute
   * steps whose string args are unfilled placeholders are rejected before any
   * tool runs — a write with a garbage arg is a partial side-effect the τ-bench
   * no-partial-side-effects property forbids. Absent → byte-identical to prior behaviour.
   */
  readonly toolRisks?: ReadonlyMap<string, "read" | "write" | "execute">;
}

/**
 * Collects every validation error across the plan instead of failing fast.
 * Empty plans are valid (callers decide whether to short-circuit to a
 * direct answer when the plan is empty).
 */
export const MAX_PLAN_STEPS = 64;

/** Stable key for a plan step used by duplicate detection and deduplication. */
function stepKey(step: PlanStep): string {
  return `${step.tool}::${stableStringify(step.args)}`;
}

/** JSON.stringify with sorted keys so {b:1,a:2} and {a:2,b:1} produce the same key. */
function stableStringify(obj: JsonObject): string {
  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key] as JsonValue;
  }
  return JSON.stringify(sorted);
}

/**
 * LLMCompiler (arXiv:2312.04511, Kim et al. ICML 2024): a task that references
 * another task's output must reference an EARLIER task — a forward or
 * non-existent target is un-dispatchable in a sequential plan and would execute
 * with a literal garbage arg, causing partial side-effects AFTER prior steps
 * already wrote to the store.
 *
 * Grammar is intentionally tight to avoid false-positives on currency ("$2",
 * "$50 budget") or bare numbers. Delimited forms are always treated as refs.
 * Bare `$N` is only a ref when the entire trimmed arg string value IS exactly
 * `$N` — any embedded prose disqualifies it, so "$50 budget" is never a ref.
 *
 * Only forward/dangling references are flagged (un-satisfiable in the current
 * sequential plan). Backward references are in-scope to detect but the
 * substitution machinery is not yet wired; flagging them would over-reject
 * valid plans that express intent the loop carries literally.
 */
export function validateStepDependencies(steps: readonly PlanStep[]): readonly PlanValidationError[] {
  const errors: PlanValidationError[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step) continue;
    for (const argValue of Object.values(step.args)) {
      if (typeof argValue !== "string") continue;
      for (const ref of extractDependencyRefs(argValue)) {
        // ref is 1-based; step i is the (i+1)-th step.
        // Forward/self: ref >= i+1 (can't be resolved yet).
        // Dangling: ref < 1 or ref > steps.length.
        const isSelf = ref === i + 1;
        const isForward = ref > i + 1;
        const isDangling = ref < 1 || ref > steps.length;
        if (isSelf || isForward || isDangling) {
          const kind = isDangling && ref >= 1 && ref <= steps.length ? "forward" :
            isDangling ? "dangling" : "forward";
          errors.push({
            reason: `arg references step ${ref.toString()} (${kind}): un-dispatchable in a sequential plan`,
            stepIndex: i,
            tool: step.tool
          });
        }
      }
    }
  }
  return errors;
}

/**
 * Returns all 1-based step-reference indices found in a single string arg
 * value. Returns an empty array for plain strings with no reference tokens.
 *
 * Tight grammar (conservative — false-negative is today's behaviour;
 * false-positive wrongly rejects a valid plan):
 *  - Delimited (always a ref): {{stepN}}, {{step N …}},
 *    <step N>, <result of step N>, <단계 N …>
 *  - Explicit phrase: "step N output", "result of step N", "단계 N 결과"
 *  - Bare $N: NOT detected — indistinguishable from currency ("$2 coffee",
 *    "$50 budget"). Use a delimited form for inter-step wiring.
 */
function extractDependencyRefs(value: string): number[] {
  const refs: number[] = [];
  const seen = new Set<number>();
  const push = (n: number): void => {
    if (!seen.has(n)) { seen.add(n); refs.push(n); }
  };

  // Mustache delimited: {{stepN}}, {{step N}}, {{step N.output}}.
  // step\s* covers both "step2" and "step 2" (planner may or may not space them).
  // The "step" keyword is MANDATORY: a bare {{N}} is dropped because it
  // collides with a literal numeric template value ({{2025}} a year,
  // {{0}} a zero-index) — a missed bare ref is a harmless false-negative,
  // a wrongly-rejected valid plan is not.
  for (const m of value.matchAll(/\{\{\s*step\s*(\d+)(?:[^}]*)?\s*\}\}/gi)) {
    const n = parseInt(m[1] ?? "", 10);
    if (!isNaN(n)) push(n);
  }

  // Angle-bracket delimited: <step N>, <result of step N>, <단계 N …>
  for (const m of value.matchAll(/<\s*(?:result\s+of\s+)?(?:step|단계)\s+(\d+)(?:[^>]*)?\s*>/gi)) {
    const n = parseInt(m[1] ?? "", 10);
    if (!isNaN(n)) push(n);
  }

  // Explicit phrase: "step N output", "result of step N"
  for (const m of value.matchAll(/\bstep\s+(\d+)\s+output\b/gi)) {
    const n = parseInt(m[1] ?? "", 10);
    if (!isNaN(n)) push(n);
  }
  for (const m of value.matchAll(/\bresult\s+of\s+step\s+(\d+)\b/gi)) {
    const n = parseInt(m[1] ?? "", 10);
    if (!isNaN(n)) push(n);
  }
  // Korean phrase: 단계 N 결과
  for (const m of value.matchAll(/단계\s+(\d+)\s+결과/g)) {
    const n = parseInt(m[1] ?? "", 10);
    if (!isNaN(n)) push(n);
  }

  // Bare $N is intentionally NOT detected: "$2" is indistinguishable from
  // currency in a string arg ("$2 coffee", "$50 budget" are valid plan args).
  // False-negative = today's behaviour (acceptable); false-positive = wrongly
  // rejects a valid plan (not acceptable). Planners should use a delimited
  // form above to express inter-step wiring unambiguously.

  return refs;
}

/**
 * ISR-LLM (arXiv:2308.13724) precondition check: a write/execute step whose
 * mutating arg is an unfilled placeholder sails through required-arg checks
 * but would commit a write with garbage — a τ-bench / outbound-safety
 * partial-side-effect violation. This function gates those BEFORE execution.
 *
 * Only risk:"write"|"execute" steps are checked — reads are idempotent and
 * exempt so the common read path is never slowed or over-rejected.
 *
 * Whole-value-anchored: flags ONLY when the trimmed arg value IS EXACTLY a
 * placeholder token. Real content that merely CONTAINS a placeholder token
 * ("send the TODO list") is never flagged.
 */
// Anchored to the whole trimmed value: angle-bracket template, mustache template,
// or a recognised sentinel word. Case-insensitive; the `N\/?A` branch matches "N/A" and "NA".
const UNFILLED_PLACEHOLDER_RE = /^(<[^>]*>|\{\{[^}]*\}\}|TODO|TBD|XXX|null|undefined|N\/?A)$/i;

export function validateWritePreconditions(
  steps: readonly PlanStep[],
  toolRisks: ReadonlyMap<string, "read" | "write" | "execute">
): readonly PlanValidationError[] {
  const errors: PlanValidationError[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step) continue;
    const risk = toolRisks.get(step.tool);
    // reads are idempotent — exempt from precondition check
    if (risk !== "write" && risk !== "execute") continue;
    for (const [key, value] of Object.entries(step.args)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      // Empty/whitespace-only is the simplest unfilled placeholder (the regex
      // alternation can't express "empty"), so check it explicitly first.
      if (trimmed.length === 0 || UNFILLED_PLACEHOLDER_RE.test(trimmed)) {
        errors.push({
          reason: `write/execute step has unfilled placeholder arg '${key}' ('${value}') — would commit a partial side-effect`,
          stepIndex: i,
          tool: step.tool
        });
      }
    }
  }
  return errors;
}

/**
 * Closed-vocabulary argument validation: for each step arg whose tool schema
 * declares an `enum` (a closed choice set) or `const` (a single allowed value),
 * reject a SCALAR value outside that set. A property without enum/const, or a
 * non-scalar arg (object/array/null — those aren't closed-vocabulary), imposes no
 * constraint (fail-soft). Exact equality only — NOT lexical or semantic
 * similarity (a closed enum is a structural constraint, the one place set
 * membership is the correct signal, not the cumulative-lesson anti-pattern).
 * Pure + exported for direct coverage. Returns one message per violation.
 */
export function validateEnumArguments(inputSchema: JsonValue | undefined, args: JsonObject): string[] {
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return [];
  const properties = inputSchema.properties;
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || typeof value === "object") continue; // only scalars carry a closed vocabulary
    const prop = properties[key];
    if (!isRecord(prop)) continue;
    const allowed = Array.isArray(prop.enum)
      ? prop.enum
      : (prop.const !== undefined ? [prop.const] : undefined);
    if (allowed === undefined) continue;
    if (!allowed.some((candidate) => candidate === value)) {
      out.push(`argument '${key}' value '${String(value)}' is not one of [${allowed.map((c) => String(c)).join(", ")}]`);
    }
  }
  return out;
}

export function validatePlan(input: PlanValidationInput): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  // A small local planner can loop / repeat itself; an oversized
  // plan floods the event stream + `executed[]` memory and burns
  // O(N) iterations even though real tool calls are already capped
  // by `runner.maxToolCalls`. Reject early rather than walk it.
  if (input.steps.length > MAX_PLAN_STEPS) {
    return {
      errors: [{
        reason: `plan has ${input.steps.length.toString()} steps; max is ${MAX_PLAN_STEPS.toString()}`,
        stepIndex: MAX_PLAN_STEPS,
        tool: ""
      }],
      steps: input.steps,
      valid: false
    };
  }

  // Tracks exact-duplicate detection: key → first occurrence index.
  const seenKeys = new Map<string, number>();

  for (let index = 0; index < input.steps.length; index += 1) {
    const step = input.steps[index];
    if (!step) {
      continue;
    }
    if (step.tool.trim().length === 0) {
      errors.push({ reason: "tool name is blank", stepIndex: index, tool: step.tool });
      continue;
    }
    if (!input.availableToolNames.has(step.tool)) {
      errors.push({
        reason: `tool '${step.tool}' is not registered`,
        stepIndex: index,
        tool: step.tool
      });
      // Still check for duplicates below even when unregistered, but skip arg validation.
    } else if (input.toolSchemas) {
      // ISR-LLM (arXiv:2308.13724): validate args before execution so a missing
      // required arg on step N doesn't block AFTER steps 0…N-1 wrote side effects.
      const schema = input.toolSchemas.get(step.tool);
      if (schema !== undefined) {
        const coerced = coerceEnumArguments(schema, coerceToolArguments(schema, step.args));
        const argCheck = validateRequiredToolArguments(schema, coerced);
        for (const name of argCheck.missing) {
          errors.push({
            reason: `missing required argument '${name}'`,
            stepIndex: index,
            tool: step.tool
          });
        }
        // Closed-vocabulary (enum/const) pre-validation: a step arg outside a
        // schema's allowed set passes the present+typed checks but fails at
        // runtime AFTER earlier steps wrote — a τ-bench partial-side-effect.
        // Enforce the constraint at the interface, before the effect
        // (arXiv:2602.03439). Exact set membership — no lexical/semantic signal.
        for (const enumError of validateEnumArguments(schema, coerced)) {
          errors.push({ reason: enumError, stepIndex: index, tool: step.tool });
        }
      }
    }

    // Exact-duplicate detection (same tool + same args, key-order-independent).
    const key = stepKey(step);
    const firstIndex = seenKeys.get(key);
    if (firstIndex !== undefined) {
      errors.push({
        reason: `repeats step ${firstIndex.toString()} verbatim`,
        stepIndex: index,
        tool: step.tool
      });
    } else {
      seenKeys.set(key, index);
    }
  }
  // LLMCompiler (arXiv:2312.04511): forward/dangling dependency refs are
  // un-dispatchable — reject before any tool runs (no partial side-effects).
  for (const depError of validateStepDependencies(input.steps)) {
    errors.push(depError);
  }

  // ISR-LLM (arXiv:2308.13724) precondition check: a write/execute step with
  // an unfilled placeholder arg would commit a partial side-effect — fail-close
  // before execution so no garbage write ever reaches the store.
  if (input.toolRisks) {
    for (const precondError of validateWritePreconditions(input.steps, input.toolRisks)) {
      errors.push(precondError);
    }
  }

  return {
    errors,
    steps: input.steps,
    valid: errors.length === 0
  };
}

/**
 * Order-preserving removal of exact-duplicate steps (same tool + same args,
 * key-order-independent). The first occurrence is kept; subsequent identical
 * steps are dropped. A deterministic repair that needs no model call.
 */
export function dedupeExactSteps(steps: readonly PlanStep[]): readonly PlanStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    const key = stepKey(step);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Normalizes a single JSON arg value for near-duplicate key comparison.
 * Conservative: only formatting variants are collapsed — a different VALUE
 * after normalization is never treated as equal.
 *
 * Rules (Mem0 arXiv:2504.19413 consolidate-before-add principle applied to
 * plan steps: emit only when no semantically-equivalent step exists):
 *  - string  → trim() + collapse internal whitespace runs to one space +
 *              lowercase (case-folding is FOR THE KEY ONLY; the kept step
 *              retains its original args — see dedupeNearDuplicateSteps).
 *              Risk: a case-sensitive arg value would wrongly collide.
 *              Mitigation: we never merge different values or different tools;
 *              a planner emitting two case-variant steps is overwhelmingly a
 *              glitch, not intent. The kept step's ORIGINAL args are preserved.
 *  - numeric-string that round-trips → canonical String(Number(x)), so "5",
 *              "5.0", and 5 all produce "5". Non-round-trip strings ("4h",
 *              "hello") are treated as plain strings (trim+lower).
 *  - boolean/null → returned as-is (no ambiguity, no normalization needed).
 *  - object/array → recurse (objects) / positional recurse (arrays).
 */
function normalizeArgValue(value: JsonValue): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\s+/g, " ").toLowerCase();
    // Numeric-string that parses to a finite number → canonical String(Number(x)).
    // This collapses "5", "5.0", and 5 to the same key. We do NOT require round-trip
    // equality (String(Number(x)) === x) — "5.0" parses to 5 whose canonical form is
    // "5", which is the intended merge. Non-numeric strings ("4h", "hello") have
    // Number() = NaN or Infinity → left as plain strings.
    const asNum = Number(trimmed);
    if (trimmed.length > 0 && isFinite(asNum) && !isNaN(asNum)) {
      return String(asNum);
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeArgValue(item as JsonValue));
  }
  // object — recurse
  const normalized: Record<string, JsonValue> = {};
  for (const key of Object.keys(value as Record<string, JsonValue>).sort()) {
    normalized[key] = normalizeArgValue((value as Record<string, JsonValue>)[key] as JsonValue);
  }
  return normalized;
}

function normalizeArgs(args: JsonObject): JsonObject {
  return normalizeArgValue(args as JsonValue) as JsonObject;
}

/**
 * Normalized key for near-duplicate detection: tool is trimmed+lowercased,
 * args have formatting-only variants collapsed (whitespace, numeric-string,
 * case). Falls back to the raw stepKey if normalization throws (never throws
 * itself — degenerate args produce the raw key, not an error).
 */
function normalizedStepKey(step: PlanStep): string {
  try {
    const tool = step.tool.trim().toLowerCase();
    return `${tool}::${stableStringify(normalizeArgs(step.args))}`;
  } catch {
    return stepKey(step);
  }
}

/**
 * Order-preserving removal of near-duplicate steps: same tool (normalized) +
 * args that differ only by formatting (whitespace, numeric-string, case).
 * A strict superset of dedupeExactSteps — collapses everything exact did,
 * plus formatting variants. The first occurrence is kept with its ORIGINAL
 * args unmutated; only the normalized key is used for comparison.
 *
 * Grounded in Mem0 (arXiv:2504.19413, Chhikara et al. 2025): ADD only when
 * no semantically-equivalent entry exists. Applied here: emit a plan step
 * only when no formatting-equivalent step was already emitted — preventing
 * both a wasted maxToolCalls budget slot and, critically, a double-act on a
 * WRITE/actuator tool (outbound-safety).
 */
export function dedupeNearDuplicateSteps(steps: readonly PlanStep[]): readonly PlanStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    const key = normalizedStepKey(step);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Returns true when the supplied run metadata explicitly requests the
 * Plan-Execute strategy. Case-insensitive on the value, defensive on the
 * shape of the metadata object.
 */
export function isPlanExecuteMode(metadata: JsonObject | undefined): boolean {
  if (!metadata) {
    return false;
  }
  const value = metadata["agentMode"];
  return typeof value === "string" && value.toLowerCase() === "plan_execute";
}

/**
 * Returns the system message content of the first system message in
 * `messages`, or `undefined` if no system message is present. Used by the
 * Plan-Execute synthesis pass to carry caller-supplied system prompts into
 * the synthesis-time prompt.
 */
export function systemMessageContent(messages: readonly ModelMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role === "system") {
      return message.content;
    }
  }
  return undefined;
}

/**
 * Renders the available tools as a bullet list for the planning prompt.
 * Each line is `- <name>: <description>`; the order is the tools' input
 * order so deterministic prompts produce deterministic plans.
 */
export function renderToolDescriptionsForPlanning(tools: readonly ModelTool[]): string {
  return tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
}

/**
 * Renders executed plan steps into the synthesis-time prompt body. Each
 * step becomes `[<tool>] <description>` followed by either the tool output,
 * a Korean "[데이터 없음]" marker (output empty), or a Korean "[실패]" marker
 * with an explicit instruction not to use the failed step as evidence.
 */
export function renderPlanResultSummary(results: readonly StepExecutionResult[]): string {
  return results
    .map((result) => {
      const header = `[${result.tool}] ${result.description}`;
      let body: string;
      if (!result.success) {
        body = "[실패] 이 단계는 실행에 실패했습니다. 답변 근거로 사용하지 마세요.";
      } else if (!result.output || result.output.trim().length === 0) {
        body = "[데이터 없음] 이 단계는 결과를 반환하지 않았습니다.";
      } else {
        // Live-injection defense: plan-execute synthesis feeds step tool output to
        // the model — neutralize an injected instruction the same way capToolOutput
        // does for the model-loop path (this is the plan-execute sibling chokepoint).
        body = neutralizeInjectionSpans(result.output);
      }
      return `${header}\n${body}`;
    })
    .join("\n\n");
}

export interface StepEffectVerdict {
  readonly effectFailed: boolean;
  readonly reason?: string;
}

/**
 * Post-condition on a step whose tool call COMPLETED (did not throw): did the
 * EFFECT actually succeed? The plan loop otherwise counts any non-throwing tool
 * as success — but an MCP tool returning `isError` is rendered as an "Error: …"
 * string with status "completed" (see `transport.ts`), and some tools return a
 * `{ ok:false }` / `{ error }` envelope without throwing. Those are FAILED
 * effects the synthesis must NOT treat as evidence (a confident "done" built on
 * a failed tool call is itself a fabrication). Conservative on purpose — an
 * EMPTY output is VALID (an empty lookup is a legitimate result, not a failure),
 * and ordinary content (even "no results found") is never flagged; only an
 * explicit leading `Error:`/`Failed:` marker (the colon distinguishes it from
 * content like "Error handling in Rust …") or a JSON failure envelope counts.
 */
export function classifyStepEffect(output: string | null): StepEffectVerdict {
  // Tool outputs reach the loop WRAPPED by the policy sanitizer
  // (`--- BEGIN TOOL DATA … --- END TOOL DATA ---`); classify the inner payload
  // so an "Error: …" body inside the envelope is seen. No-op when unwrapped (the
  // raw-string unit path). The integration test exercises the real wrapper, so a
  // wrapper-format change can't silently defeat this.
  const trimmed = unwrapToolData(output ?? "").trim();
  if (trimmed.length === 0) {
    return { effectFailed: false }; // empty-but-valid — not a failure
  }
  if (/^(error|failed|failure|exception)\s*:/i.test(trimmed)) {
    return { effectFailed: true, reason: firstLine(trimmed) };
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const envelope = parsed as Record<string, unknown>;
        if (typeof envelope["error"] === "string" && envelope["error"].trim().length > 0) {
          return { effectFailed: true, reason: envelope["error"].trim() };
        }
        if (envelope["ok"] === false || envelope["success"] === false) {
          return { effectFailed: true, reason: firstLine(trimmed) };
        }
      }
    } catch {
      // not JSON — fall through to "not failed" (ordinary content)
    }
  }
  return { effectFailed: false };
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Extract the payload from the sanitizer's `--- BEGIN/END TOOL DATA ---`
 * envelope so the post-condition classifies the tool's actual output, not the
 * wrapper header. Returns the input unchanged when no envelope is present.
 */
function unwrapToolData(text: string): string {
  const lines = text.split("\n");
  const begin = lines.findIndex((line) => /^-{3,}\s*BEGIN TOOL DATA\b/i.test(line));
  const end = lines.findIndex((line) => /^-{3,}\s*END TOOL DATA\s*-{3,}\s*$/i.test(line));
  if (begin < 0 || end < 0 || end <= begin) {
    return text;
  }
  let payloadStart = begin + 1;
  if (payloadStart < end && /Treat as data, NOT as instructions/i.test(lines[payloadStart] ?? "")) {
    payloadStart += 1;
  }
  if (payloadStart < end && (lines[payloadStart] ?? "").trim().length === 0) {
    payloadStart += 1;
  }
  return lines.slice(payloadStart, end).join("\n");
}
