import { createHash } from "node:crypto";

import {
  createGoalActionTerminalReceipt,
  type GoalActionTerminalReceipt
} from "./goal-action-terminal.js";

const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DIMENSIONS = ["attempts", "wallTimeMs", "toolCalls", "modelCalls", "effects"] as const;
const HARD_MAX = Object.freeze({
  attempts: 20,
  effects: 100,
  modelCalls: 100,
  toolCalls: 100,
  wallTimeMs: 12 * 60 * 1_000
});

export type GoalActionBudgetDimension = typeof DIMENSIONS[number];
export type GoalActionBudgetValues = Readonly<Record<GoalActionBudgetDimension, number>>;

export interface GoalActionBudgetInput {
  readonly actionId: string;
  readonly limits: GoalActionBudgetValues;
  readonly usage: GoalActionBudgetValues;
}

export type GoalActionBudgetDecision =
  | {
      readonly decision: "within-budget";
      readonly remaining: GoalActionBudgetValues;
    }
  | {
      readonly decision: "terminal";
      readonly exhausted: readonly GoalActionBudgetDimension[];
      readonly terminal: GoalActionTerminalReceipt;
    };

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

function values(
  input: unknown,
  label: "limits" | "usage"
): GoalActionBudgetValues {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactShape(input, DIMENSIONS, label);
  const result = {} as Record<GoalActionBudgetDimension, number>;
  for (const dimension of DIMENSIONS) {
    const value = ownData(input, dimension, `${label}.${dimension}`);
    if (
      typeof value !== "number"
      || !Number.isSafeInteger(value)
      || value < (label === "limits" ? 1 : 0)
      || (label === "limits" && value > HARD_MAX[dimension])
    ) {
      throw new Error(
        label === "limits"
          ? `${label}.${dimension} must be a positive safe integer at or below ${HARD_MAX[dimension].toString()}`
          : `${label}.${dimension} must be a non-negative safe integer`
      );
    }
    result[dimension] = value;
  }
  return Object.freeze(result);
}

function budgetEvidenceDigest(
  actionId: string,
  limits: GoalActionBudgetValues,
  usage: GoalActionBudgetValues,
  exhausted: readonly GoalActionBudgetDimension[]
): string {
  const payload = JSON.stringify({ actionId, exhausted, limits, usage });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

/**
 * Assess one action's composite execution budget. This is a pure gate: it
 * neither consumes resources nor starts work.
 */
export function assessGoalActionBudget(
  input: GoalActionBudgetInput
): GoalActionBudgetDecision {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("budget input must be an object");
  }
  assertExactShape(input, ["actionId", "limits", "usage"], "budget input");
  const actionId = ownData(input, "actionId", "actionId");
  if (typeof actionId !== "string" || !ACTION_ID.test(actionId)) {
    throw new Error("actionId must be a valid exact id");
  }
  const limits = values(ownData(input, "limits", "limits"), "limits");
  const usage = values(ownData(input, "usage", "usage"), "usage");
  const exhausted = Object.freeze(
    DIMENSIONS.filter((dimension) => usage[dimension] >= limits[dimension])
  );
  if (exhausted.length === 0) {
    const remaining = {} as Record<GoalActionBudgetDimension, number>;
    for (const dimension of DIMENSIONS) {
      remaining[dimension] = limits[dimension] - usage[dimension];
    }
    return Object.freeze({
      decision: "within-budget",
      remaining: Object.freeze(remaining)
    });
  }

  const labels = exhausted.join(", ");
  return Object.freeze({
    decision: "terminal",
    exhausted,
    terminal: createGoalActionTerminalReceipt({
      actionId,
      blocker: `budget exhausted: ${labels}`,
      evidenceDigest: budgetEvidenceDigest(actionId, limits, usage, exhausted),
      resumeCondition: `explicitly revise the exhausted budget with new evidence: ${labels}`,
      terminalKind: "no-progress"
    })
  });
}
