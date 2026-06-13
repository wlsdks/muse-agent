import type { ModelMessage, ModelTool } from "@muse/model";
import type { JsonObject, JsonValue } from "@muse/shared";
import { coerceToolArguments, validateRequiredToolArguments } from "@muse/tools";

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
        const coerced = coerceToolArguments(schema, step.args);
        const argCheck = validateRequiredToolArguments(schema, coerced);
        for (const name of argCheck.missing) {
          errors.push({
            reason: `missing required argument '${name}'`,
            stepIndex: index,
            tool: step.tool
          });
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
        body = result.output;
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
