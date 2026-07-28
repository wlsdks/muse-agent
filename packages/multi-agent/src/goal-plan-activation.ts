import {
  reviseGoalDecompositionDraft,
  type GoalDecompositionDraft,
  type GoalDecompositionDraftSubtask
} from "./goal-decomposition-draft.js";

const MAX_REQUIREMENTS = 20;
const MAX_REQUIREMENT_LENGTH = 2_000;

export interface GoalPlanActivationRequirements {
  readonly acceptanceCriteria: readonly string[];
  readonly killConditions: readonly string[];
  readonly nonGoals: readonly string[];
}

export interface ActiveGoalPlan {
  readonly acceptanceCriteria: readonly string[];
  readonly assumptions: readonly string[];
  readonly goal: string;
  readonly killConditions: readonly string[];
  readonly nonGoals: readonly string[];
  readonly schemaVersion: 1;
  readonly status: "active";
  readonly subtasks: readonly GoalDecompositionDraftSubtask[];
  readonly unknowns: readonly string[];
}

function normalizedKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function ownDataProperty(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`${label} must be an own data property`);
  }
  return descriptor.value;
}

function denseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const length = ownDataProperty(value, "length", `${label}.length`);
  if (!Number.isSafeInteger(length) || Number(length) < 0) {
    throw new Error(`${label}.length must be a non-negative safe integer`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < Number(length); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index.toString());
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`${label}[${index.toString()}] must be present as a data value`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function denseStringArray(value: unknown, label: string): readonly string[] {
  return denseArray(value, label).map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${label}[${index.toString()}] must be a string`);
    }
    return entry;
  });
}

function canonicalDraft(value: GoalDecompositionDraft): GoalDecompositionDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("draft must be an object");
  }
  const schemaVersion = ownDataProperty(value, "schemaVersion", "draft.schemaVersion");
  const status = ownDataProperty(value, "status", "draft.status");
  if (schemaVersion !== 1 || status !== "draft") {
    throw new Error("draft must have own schemaVersion 1 and status 'draft'");
  }
  const goal = ownDataProperty(value, "goal", "draft.goal");
  if (typeof goal !== "string") {
    throw new Error("draft.goal must be a string");
  }
  const assumptions = denseStringArray(
    ownDataProperty(value, "assumptions", "draft.assumptions"),
    "draft.assumptions"
  );
  const unknowns = denseStringArray(
    ownDataProperty(value, "unknowns", "draft.unknowns"),
    "draft.unknowns"
  );
  const rawSubtasks = denseArray(
    ownDataProperty(value, "subtasks", "draft.subtasks"),
    "draft.subtasks"
  );
  const subtasks = rawSubtasks.map((rawSubtask, index) => {
    const label = `draft.subtasks[${index.toString()}]`;
    if (typeof rawSubtask !== "object" || rawSubtask === null || Array.isArray(rawSubtask)) {
      throw new Error(`${label} must be an object`);
    }
    const id = ownDataProperty(rawSubtask, "id", `${label}.id`);
    const title = ownDataProperty(rawSubtask, "title", `${label}.title`);
    if (typeof id !== "string" || typeof title !== "string") {
      throw new Error(`${label} id and title must be strings`);
    }
    const dependsOn = denseStringArray(
      ownDataProperty(rawSubtask, "dependsOn", `${label}.dependsOn`),
      `${label}.dependsOn`
    );
    return { dependsOn, id, title };
  });

  return reviseGoalDecompositionDraft({
    assumptions,
    goal,
    schemaVersion: 1,
    status: "draft",
    subtasks,
    unknowns
  }, {});
}

function requiredList(values: unknown, label: string): readonly string[] {
  const entries = denseStringArray(values, label);
  if (entries.length === 0) {
    throw new Error(`${label} must contain at least one item`);
  }
  if (entries.length > MAX_REQUIREMENTS) {
    throw new Error(`${label} exceeds the ${MAX_REQUIREMENTS.toString()}-item cap`);
  }
  const normalized = entries.map((value, index) => {
    const text = value.trim().replace(/\s+/gu, " ");
    if (text.length === 0) {
      throw new Error(`${label}[${index.toString()}] must be a non-empty string`);
    }
    if (text.length > MAX_REQUIREMENT_LENGTH) {
      throw new Error(`${label}[${index.toString()}] exceeds the ${MAX_REQUIREMENT_LENGTH.toString()}-character cap`);
    }
    return text;
  });
  const keys = normalized.map(normalizedKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${label} contains duplicate items`);
  }
  return Object.freeze(normalized);
}

function assertNoContradictions(
  draft: GoalDecompositionDraft,
  requirements: GoalPlanActivationRequirements
): void {
  const acceptance = new Set(requirements.acceptanceCriteria.map(normalizedKey));
  const nonGoals = new Set(requirements.nonGoals.map(normalizedKey));
  const killConditions = new Set(requirements.killConditions.map(normalizedKey));

  for (const key of acceptance) {
    if (nonGoals.has(key) || killConditions.has(key)) {
      throw new Error("plan requirements contradict: an acceptance criterion is also excluded or a kill condition");
    }
  }
  const planned = [draft.goal, ...draft.subtasks.map((subtask) => subtask.title)].map(normalizedKey);
  if (planned.some((key) => nonGoals.has(key))) {
    throw new Error("plan requirements contradict: the goal or a planned subtask is also a non-goal");
  }
}

/**
 * Promote an inert decomposition draft to an active plan only when its
 * completion, scope, and stop boundaries are explicit and non-contradictory.
 * This gate is pure: active does not itself authorize or execute any effect.
 */
export function activateGoalPlan(
  draft: GoalDecompositionDraft,
  input: GoalPlanActivationRequirements
): ActiveGoalPlan {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("plan activation requirements must be an object");
  }
  const validatedDraft = canonicalDraft(draft);
  const requirements = {
    acceptanceCriteria: requiredList(
      ownDataProperty(input, "acceptanceCriteria", "acceptanceCriteria"),
      "acceptanceCriteria"
    ),
    killConditions: requiredList(
      ownDataProperty(input, "killConditions", "killConditions"),
      "killConditions"
    ),
    nonGoals: requiredList(
      ownDataProperty(input, "nonGoals", "nonGoals"),
      "nonGoals"
    )
  };
  assertNoContradictions(validatedDraft, requirements);

  return Object.freeze({
    acceptanceCriteria: requirements.acceptanceCriteria,
    assumptions: validatedDraft.assumptions,
    goal: validatedDraft.goal,
    killConditions: requirements.killConditions,
    nonGoals: requirements.nonGoals,
    schemaVersion: 1,
    status: "active",
    subtasks: validatedDraft.subtasks,
    unknowns: validatedDraft.unknowns
  });
}
