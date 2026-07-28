import {
  activateGoalPlan,
  type ActiveGoalPlan
} from "./goal-plan-activation.js";
import type {
  GoalDecompositionDraft,
  GoalDecompositionDraftSubtask
} from "./goal-decomposition-draft.js";

const MAX_SELECTOR_ITEMS = 20;

export interface GoalActionReadiness {
  readonly completedSubtaskIds: readonly string[];
  readonly missingAuthoritySubtaskIds: readonly string[];
  readonly ownerDecisionSubtaskIds: readonly string[];
}

function ownData(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`${label} must be an own data property`);
  }
  return descriptor.value;
}

function denseValues(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const length = ownData(value, "length", `${label}.length`);
  if (!Number.isSafeInteger(length) || Number(length) < 0) {
    throw new Error(`${label}.length must be a non-negative safe integer`);
  }
  if (Number(length) > MAX_SELECTOR_ITEMS) {
    throw new Error(`${label} exceeds the ${MAX_SELECTOR_ITEMS.toString()}-item cap`);
  }
  const values: unknown[] = [];
  for (let index = 0; index < Number(length); index += 1) {
    values.push(ownData(value, index.toString(), `${label}[${index.toString()}]`));
  }
  return values;
}

function denseStrings(value: unknown, label: string): readonly string[] {
  return denseValues(value, label).map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${label}[${index.toString()}] must be a string`);
    }
    return entry;
  });
}

function snapshotSubtasks(value: unknown): readonly GoalDecompositionDraftSubtask[] {
  return denseValues(value, "plan.subtasks").map((entry, index) => {
    const label = `plan.subtasks[${index.toString()}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${label} must be an object`);
    }
    const id = ownData(entry, "id", `${label}.id`);
    const title = ownData(entry, "title", `${label}.title`);
    if (typeof id !== "string" || typeof title !== "string") {
      throw new Error(`${label} id and title must be strings`);
    }
    return {
      dependsOn: denseStrings(ownData(entry, "dependsOn", `${label}.dependsOn`), `${label}.dependsOn`),
      id,
      title
    };
  });
}

function canonicalActivePlan(value: ActiveGoalPlan): ActiveGoalPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("plan must be an object");
  }
  if (
    ownData(value, "schemaVersion", "plan.schemaVersion") !== 1
    || ownData(value, "status", "plan.status") !== "active"
  ) {
    throw new Error("plan must have own schemaVersion 1 and status 'active'");
  }
  const goal = ownData(value, "goal", "plan.goal");
  if (typeof goal !== "string") throw new Error("plan.goal must be a string");
  const draft: GoalDecompositionDraft = {
    assumptions: denseStrings(ownData(value, "assumptions", "plan.assumptions"), "plan.assumptions"),
    goal,
    schemaVersion: 1,
    status: "draft",
    subtasks: snapshotSubtasks(ownData(value, "subtasks", "plan.subtasks")),
    unknowns: denseStrings(ownData(value, "unknowns", "plan.unknowns"), "plan.unknowns")
  };
  return activateGoalPlan(draft, {
    acceptanceCriteria: denseStrings(
      ownData(value, "acceptanceCriteria", "plan.acceptanceCriteria"),
      "plan.acceptanceCriteria"
    ),
    killConditions: denseStrings(
      ownData(value, "killConditions", "plan.killConditions"),
      "plan.killConditions"
    ),
    nonGoals: denseStrings(ownData(value, "nonGoals", "plan.nonGoals"), "plan.nonGoals")
  });
}

function readinessSet(
  input: object,
  key: keyof GoalActionReadiness,
  validIds: ReadonlySet<string>
): ReadonlySet<string> {
  const ids = denseStrings(ownData(input, key, key), key);
  const set = new Set(ids);
  if (set.size !== ids.length) throw new Error(`${key} contains duplicate ids`);
  for (const id of ids) {
    if (!validIds.has(id)) throw new Error(`${key} contains unknown subtask id '${id}'`);
  }
  return set;
}

/**
 * Return at most one action, preserving plan order. Readiness is exact-ID only:
 * a missing dependency, owner decision, or authority blocks the candidate.
 */
export function selectNextReadyGoalAction(
  plan: ActiveGoalPlan,
  readiness: GoalActionReadiness
): GoalDecompositionDraftSubtask | undefined {
  const canonicalPlan = canonicalActivePlan(plan);
  if (typeof readiness !== "object" || readiness === null || Array.isArray(readiness)) {
    throw new Error("readiness must be an object");
  }
  const validIds = new Set(canonicalPlan.subtasks.map((subtask) => subtask.id));
  const completed = readinessSet(readiness, "completedSubtaskIds", validIds);
  const ownerDecision = readinessSet(readiness, "ownerDecisionSubtaskIds", validIds);
  const missingAuthority = readinessSet(readiness, "missingAuthoritySubtaskIds", validIds);
  for (const id of validIds) {
    const memberships = Number(completed.has(id)) + Number(ownerDecision.has(id)) + Number(missingAuthority.has(id));
    if (memberships > 1) throw new Error(`readiness state contradicts for subtask '${id}'`);
  }

  return canonicalPlan.subtasks.find((subtask) =>
    !completed.has(subtask.id)
    && !ownerDecision.has(subtask.id)
    && !missingAuthority.has(subtask.id)
    && subtask.dependsOn.every((dependency) => completed.has(dependency))
  );
}
