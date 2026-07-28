import {
  activateGoalPlan,
  type ActiveGoalPlan
} from "./goal-plan-activation.js";
import type {
  GoalDecompositionDraft,
  GoalDecompositionDraftSubtask
} from "./goal-decomposition-draft.js";

const EXACT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_EVIDENCE_ITEMS = 100;
const MAX_EVIDENCE_LINK_LENGTH = 2_000;
const PLAN_KEYS = [
  "acceptanceCriteria",
  "assumptions",
  "goal",
  "killConditions",
  "nonGoals",
  "schemaVersion",
  "status",
  "subtasks",
  "unknowns"
] as const;

export type GoalActionProgressStatus =
  | "planned"
  | "attempted"
  | "verified"
  | "blocked"
  | "rolled-back";

export type GoalProgressObservationKind =
  | "assistant-claim"
  | "tool-error"
  | "unverifiable-output"
  | "blocked";

export interface GoalProgressObservation {
  readonly actionId: string;
  readonly evidenceLink: string;
  readonly kind: GoalProgressObservationKind;
  readonly schemaVersion: 1;
}

export interface VerifiedGoalEffectReceipt {
  readonly actionId: string;
  readonly effectId: string;
  readonly effectState: "applied" | "rolled-back";
  readonly evidenceLink: string;
  readonly payloadDigest: string;
  readonly schemaVersion: 1;
  readonly status: "verified-effect";
}

export type GoalProgressEvidence =
  | GoalProgressObservation
  | VerifiedGoalEffectReceipt;

export interface GoalActionProgress {
  readonly actionId: string;
  readonly evidenceLinks: readonly string[];
  readonly status: GoalActionProgressStatus;
}

export interface GoalProgressProjection {
  readonly actions: readonly GoalActionProgress[];
  readonly completedCount: number;
  readonly completedPercentage: number;
  readonly completedSubtaskIds: readonly string[];
  readonly schemaVersion: 1;
  readonly totalCount: number;
}

function ownData(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`${label} must be an own data property`);
  }
  return descriptor.value;
}

function assertExactShape(value: object, keys: readonly string[], label: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} prototype must be plain or null`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error(`${label} shape must contain exactly ${keys.join(", ")}`);
  }
}

function denseValues(value: unknown, label: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} prototype must be Array.prototype`);
  }
  const length = ownData(value, "length", `${label}.length`);
  if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > max) {
    throw new Error(`${label}.length must be between 0 and ${max.toString()}`);
  }
  const expectedKeys = new Set([
    ...Array.from({ length: Number(length) }, (_, index) => index.toString()),
    "length"
  ]);
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.size
    || actualKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    throw new Error(`${label} must contain only dense indices and length`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < Number(length); index += 1) {
    result.push(ownData(value, index.toString(), `${label}[${index.toString()}]`));
  }
  return result;
}

function denseStrings(value: unknown, label: string, max: number): readonly string[] {
  return denseValues(value, label, max).map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${label}[${index.toString()}] must be a string`);
    }
    return entry;
  });
}

function snapshotSubtasks(value: unknown): readonly GoalDecompositionDraftSubtask[] {
  return denseValues(value, "plan.subtasks", 20).map((entry, index) => {
    const label = `plan.subtasks[${index.toString()}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${label} must be an object`);
    }
    assertExactShape(entry, ["dependsOn", "id", "title"], label);
    const id = ownData(entry, "id", `${label}.id`);
    const title = ownData(entry, "title", `${label}.title`);
    if (typeof id !== "string" || typeof title !== "string") {
      throw new Error(`${label} id and title must be strings`);
    }
    return {
      dependsOn: denseStrings(
        ownData(entry, "dependsOn", `${label}.dependsOn`),
        `${label}.dependsOn`,
        20
      ),
      id,
      title
    };
  });
}

function canonicalActivePlan(value: ActiveGoalPlan): ActiveGoalPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("plan must be an object");
  }
  assertExactShape(value, PLAN_KEYS, "plan");
  if (
    ownData(value, "schemaVersion", "plan.schemaVersion") !== 1
    || ownData(value, "status", "plan.status") !== "active"
  ) {
    throw new Error("plan must have own schemaVersion 1 and status 'active'");
  }
  const goal = ownData(value, "goal", "plan.goal");
  if (typeof goal !== "string") throw new Error("plan.goal must be a string");
  const draft: GoalDecompositionDraft = {
    assumptions: denseStrings(ownData(value, "assumptions", "plan.assumptions"), "plan.assumptions", 20),
    goal,
    schemaVersion: 1,
    status: "draft",
    subtasks: snapshotSubtasks(ownData(value, "subtasks", "plan.subtasks")),
    unknowns: denseStrings(ownData(value, "unknowns", "plan.unknowns"), "plan.unknowns", 20)
  };
  return activateGoalPlan(draft, {
    acceptanceCriteria: denseStrings(
      ownData(value, "acceptanceCriteria", "plan.acceptanceCriteria"),
      "plan.acceptanceCriteria",
      20
    ),
    killConditions: denseStrings(
      ownData(value, "killConditions", "plan.killConditions"),
      "plan.killConditions",
      20
    ),
    nonGoals: denseStrings(ownData(value, "nonGoals", "plan.nonGoals"), "plan.nonGoals", 20)
  });
}

function exactId(value: unknown, label: string): string {
  if (typeof value !== "string" || !EXACT_ID.test(value)) {
    throw new Error(`${label} must be a valid exact id`);
  }
  return value;
}

function evidenceLink(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_EVIDENCE_LINK_LENGTH) {
    throw new Error(`${label} must contain 1-${MAX_EVIDENCE_LINK_LENGTH.toString()} characters`);
  }
  return normalized;
}

function progressEvidence(
  value: unknown,
  index: number,
  validActionIds: ReadonlySet<string>
): GoalProgressEvidence {
  const label = `evidence[${index.toString()}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const statusDescriptor = Object.getOwnPropertyDescriptor(value, "status");
  const isEffect = statusDescriptor && "value" in statusDescriptor;
  assertExactShape(
    value,
    isEffect
      ? ["actionId", "effectId", "effectState", "evidenceLink", "payloadDigest", "schemaVersion", "status"]
      : ["actionId", "evidenceLink", "kind", "schemaVersion"],
    label
  );
  if (ownData(value, "schemaVersion", `${label}.schemaVersion`) !== 1) {
    throw new Error(`${label}.schemaVersion must be 1`);
  }
  const actionId = exactId(ownData(value, "actionId", `${label}.actionId`), `${label}.actionId`);
  if (!validActionIds.has(actionId)) {
    throw new Error(`${label} contains unknown actionId '${actionId}'`);
  }
  const link = evidenceLink(
    ownData(value, "evidenceLink", `${label}.evidenceLink`),
    `${label}.evidenceLink`
  );

  if (!isEffect) {
    const kind = ownData(value, "kind", `${label}.kind`);
    if (
      kind !== "assistant-claim"
      && kind !== "tool-error"
      && kind !== "unverifiable-output"
      && kind !== "blocked"
    ) {
      throw new Error(`${label}.kind is unsupported`);
    }
    return Object.freeze({ actionId, evidenceLink: link, kind, schemaVersion: 1 });
  }

  if (ownData(value, "status", `${label}.status`) !== "verified-effect") {
    throw new Error(`${label}.status must be 'verified-effect'`);
  }
  const effectId = exactId(ownData(value, "effectId", `${label}.effectId`), `${label}.effectId`);
  const effectState = ownData(value, "effectState", `${label}.effectState`);
  if (effectState !== "applied" && effectState !== "rolled-back") {
    throw new Error(`${label}.effectState must be applied or rolled-back`);
  }
  const payloadDigest = ownData(value, "payloadDigest", `${label}.payloadDigest`);
  if (typeof payloadDigest !== "string" || !SHA256_DIGEST.test(payloadDigest)) {
    throw new Error(`${label}.payloadDigest must be a lowercase sha256 digest`);
  }
  return Object.freeze({
    actionId,
    effectId,
    effectState,
    evidenceLink: link,
    payloadDigest,
    schemaVersion: 1,
    status: "verified-effect"
  });
}

/**
 * Project plan progress without executing or trusting narrative output.
 * Completion is derived only from exact verified-effect receipts whose current
 * state is applied. Claims, errors, and unverifiable output remain evidence of
 * an attempt but never increase completed progress.
 */
export function projectGoalProgress(
  plan: ActiveGoalPlan,
  evidence: readonly GoalProgressEvidence[]
): GoalProgressProjection {
  const canonicalPlan = canonicalActivePlan(plan);
  const actionIds = new Set(canonicalPlan.subtasks.map((subtask) => subtask.id));
  const records = denseValues(evidence, "evidence", MAX_EVIDENCE_ITEMS).map((value, index) =>
    progressEvidence(value, index, actionIds)
  );
  const effectSnapshots = new Map<string, VerifiedGoalEffectReceipt>();
  for (const record of records) {
    if (!("status" in record)) continue;
    const prior = effectSnapshots.get(record.effectId);
    if (prior && (
      prior.actionId !== record.actionId
      || prior.effectState !== record.effectState
      || prior.payloadDigest !== record.payloadDigest
      || prior.evidenceLink !== record.evidenceLink
    )) {
      throw new Error(`conflicting verified receipts for effectId '${record.effectId}'`);
    }
    effectSnapshots.set(record.effectId, record);
  }

  const actions = canonicalPlan.subtasks.map((subtask): GoalActionProgress => {
    const actionEvidence = records.filter((record) => record.actionId === subtask.id);
    const effects = [...effectSnapshots.values()].filter((receipt) => receipt.actionId === subtask.id);
    const hasRollback = effects.some((receipt) => receipt.effectState === "rolled-back");
    const hasApplied = effects.some((receipt) => receipt.effectState === "applied");
    const hasBlocked = actionEvidence.some((record) => "kind" in record && record.kind === "blocked");
    const status: GoalActionProgressStatus = hasApplied
      ? "verified"
      : hasRollback
        ? "rolled-back"
        : hasBlocked
          ? "blocked"
          : actionEvidence.length > 0
            ? "attempted"
            : "planned";
    return Object.freeze({
      actionId: subtask.id,
      evidenceLinks: Object.freeze([...new Set(actionEvidence.map((record) => record.evidenceLink))]),
      status
    });
  });
  const completedSubtaskIds = Object.freeze(
    actions.filter((action) => action.status === "verified").map((action) => action.actionId)
  );
  const completedCount = completedSubtaskIds.length;
  return Object.freeze({
    actions: Object.freeze(actions),
    completedCount,
    completedPercentage: (completedCount / actions.length) * 100,
    completedSubtaskIds,
    schemaVersion: 1,
    totalCount: actions.length
  });
}
