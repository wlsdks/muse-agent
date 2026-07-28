import { decomposeRequestWithKind } from "./decompose-trigger.js";

const MAX_DRAFT_ITEMS = 20;
const MAX_GOAL_LENGTH = 10_000;
const MAX_ITEM_LENGTH = 2_000;
const DRAFT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface GoalDecompositionDraftSubtask {
  readonly dependsOn: readonly string[];
  readonly id: string;
  readonly title: string;
}

export interface GoalDecompositionDraft {
  readonly assumptions: readonly string[];
  readonly goal: string;
  readonly schemaVersion: 1;
  readonly status: "draft";
  readonly subtasks: readonly GoalDecompositionDraftSubtask[];
  readonly unknowns: readonly string[];
}

export interface GoalDecompositionDraftOptions {
  readonly assumptions?: readonly string[];
  readonly unknowns?: readonly string[];
}

export interface GoalDecompositionDraftEdits {
  readonly assumptions?: readonly string[];
  readonly goal?: string;
  readonly subtasks?: readonly GoalDecompositionDraftSubtask[];
  readonly unknowns?: readonly string[];
}

function requiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds the ${maxLength.toString()}-character cap`);
  }
  return normalized;
}

function textList(values: readonly string[], label: string): readonly string[] {
  if (values.length > MAX_DRAFT_ITEMS) {
    throw new Error(`${label} exceeds the ${MAX_DRAFT_ITEMS.toString()}-item cap`);
  }
  return Object.freeze(values.map((value, index) =>
    requiredText(value, `${label}[${index.toString()}]`, MAX_ITEM_LENGTH)
  ));
}

function validateSubtasks(
  values: readonly GoalDecompositionDraftSubtask[]
): readonly GoalDecompositionDraftSubtask[] {
  if (values.length === 0) {
    throw new Error("subtasks must contain at least one item");
  }
  if (values.length > MAX_DRAFT_ITEMS) {
    throw new Error(`subtasks exceeds the ${MAX_DRAFT_ITEMS.toString()}-item cap`);
  }

  const ids = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!DRAFT_ID.test(value.id)) {
      throw new Error(`subtasks[${index.toString()}].id is invalid`);
    }
    if (ids.has(value.id)) {
      throw new Error(`duplicate subtask id '${value.id}'`);
    }
    ids.add(value.id);
  }

  const normalized = values.map((value, index) => {
    const dependencies = [...value.dependsOn];
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`subtasks[${index.toString()}] has duplicate dependencies`);
    }
    for (const dependency of dependencies) {
      if (!ids.has(dependency)) {
        throw new Error(`unknown dependency '${dependency}' for subtask '${value.id}'`);
      }
      if (dependency === value.id) {
        throw new Error(`subtask '${value.id}' cannot depend on itself`);
      }
    }
    return Object.freeze({
      dependsOn: Object.freeze(dependencies),
      id: value.id,
      title: requiredText(value.title, `subtasks[${index.toString()}].title`, MAX_ITEM_LENGTH)
    });
  });

  const byId = new Map(normalized.map((subtask) => [subtask.id, subtask]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("subtask dependencies must be acyclic");
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  return Object.freeze(normalized);
}

function buildDraft(input: {
  readonly assumptions: readonly string[];
  readonly goal: string;
  readonly subtasks: readonly GoalDecompositionDraftSubtask[];
  readonly unknowns: readonly string[];
}): GoalDecompositionDraft {
  return Object.freeze({
    assumptions: textList(input.assumptions, "assumptions"),
    goal: requiredText(input.goal, "goal", MAX_GOAL_LENGTH),
    schemaVersion: 1,
    status: "draft",
    subtasks: validateSubtasks(input.subtasks),
    unknowns: textList(input.unknowns, "unknowns")
  });
}

/**
 * Create an inert owner-editable goal draft. This function has no task/store/
 * tool dependencies: decomposition cannot authorize or execute an effect.
 */
export function createGoalDecompositionDraft(
  goal: string,
  options: GoalDecompositionDraftOptions = {}
): GoalDecompositionDraft {
  const normalizedGoal = requiredText(goal, "goal", MAX_GOAL_LENGTH);
  const decomposition = decomposeRequestWithKind(normalizedGoal);
  const subtasks = decomposition.subtasks.map((subtask, index) => ({
    dependsOn: decomposition.sequenced && index > 0
      ? [decomposition.subtasks[index - 1]!.id]
      : [],
    id: subtask.id,
    title: subtask.text
  }));
  return buildDraft({
    assumptions: options.assumptions ?? [],
    goal: normalizedGoal,
    subtasks,
    unknowns: options.unknowns ?? []
  });
}

/**
 * Apply owner edits by producing another inert draft. The prior draft is
 * deeply frozen and remains unchanged; confirmation belongs to a later gate.
 */
export function reviseGoalDecompositionDraft(
  draft: GoalDecompositionDraft,
  edits: GoalDecompositionDraftEdits
): GoalDecompositionDraft {
  return buildDraft({
    assumptions: edits.assumptions ?? draft.assumptions,
    goal: edits.goal ?? draft.goal,
    subtasks: edits.subtasks ?? draft.subtasks,
    unknowns: edits.unknowns ?? draft.unknowns
  });
}
