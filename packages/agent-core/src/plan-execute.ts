import type { JsonObject } from "@muse/shared";

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
 * Returns the substring of the first balanced `[ … ]` JSON array in `text`,
 * or `null` if none can be located. Surrounding prose is tolerated; nested
 * arrays inside step `args` are preserved.
 */
export function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

/**
 * Parses an LLM response into a plan. Returns `null` on any of: missing
 * array, malformed JSON, non-array root, non-object step, missing `tool`,
 * non-object `args`. An empty array is parsed as an empty plan.
 */
export function parsePlan(text: string): readonly PlanStep[] | null {
  const jsonText = extractJsonArray(text);
  if (jsonText === null || jsonText.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const steps: PlanStep[] = [];
  for (const entry of parsed) {
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
export function validatePlan(input: PlanValidationInput): PlanValidationResult {
  const errors: PlanValidationError[] = [];
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
