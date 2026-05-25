import type { ModelMessage, ModelTool } from "@muse/model";
import type { JsonObject } from "@muse/shared";

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
}

/**
 * Collects every validation error across the plan instead of failing fast.
 * Empty plans are valid (callers decide whether to short-circuit to a
 * direct answer when the plan is empty).
 */
export const MAX_PLAN_STEPS = 64;

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
    }
  }
  return {
    errors,
    steps: input.steps,
    valid: errors.length === 0
  };
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
