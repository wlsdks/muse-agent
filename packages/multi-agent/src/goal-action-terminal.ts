const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_TERMINAL_TEXT = 2_000;

export type GoalActionTerminalKind = "blocked" | "no-progress";

export interface GoalActionTerminalReceipt {
  readonly actionId: string;
  readonly blocker: string;
  readonly evidenceDigest: string;
  readonly resumeCondition: string;
  readonly schemaVersion: 1;
  readonly status: GoalActionTerminalKind;
}

export interface CreateGoalActionTerminalReceiptInput {
  readonly actionId: string;
  readonly blocker: string;
  readonly evidenceDigest: string;
  readonly resumeCondition: string;
  readonly terminalKind: GoalActionTerminalKind;
}

export type GoalActionResumeDecision =
  | {
      readonly decision: "held";
      readonly reason: "missing-evidence" | "unchanged-evidence";
      readonly terminal: GoalActionTerminalReceipt;
    }
  | {
      readonly actionId: string;
      readonly decision: "retry-ready";
      readonly evidenceDigest: string;
      readonly previousEvidenceDigest: string;
      readonly resumeCondition: string;
    };

function ownData(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`${label} must be an own data property`);
  }
  return descriptor.value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  if (normalized.length > MAX_TERMINAL_TEXT) {
    throw new Error(`${label} exceeds the ${MAX_TERMINAL_TEXT.toString()}-character cap`);
  }
  return normalized;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 digest`);
  }
  return value;
}

/**
 * Create a deterministic terminal receipt. The receipt records why progress
 * stopped and the explicit condition for reconsidering it; it grants no retry.
 */
export function createGoalActionTerminalReceipt(
  input: CreateGoalActionTerminalReceiptInput
): GoalActionTerminalReceipt {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("terminal input must be an object");
  }
  const actionId = ownData(input, "actionId", "actionId");
  const terminalKind = ownData(input, "terminalKind", "terminalKind");
  if (typeof actionId !== "string" || !ACTION_ID.test(actionId)) {
    throw new Error("actionId must be a valid exact id");
  }
  if (terminalKind !== "blocked" && terminalKind !== "no-progress") {
    throw new Error("terminalKind must be blocked or no-progress");
  }
  return Object.freeze({
    actionId,
    blocker: requiredText(ownData(input, "blocker", "blocker"), "blocker"),
    evidenceDigest: digest(ownData(input, "evidenceDigest", "evidenceDigest"), "evidenceDigest"),
    resumeCondition: requiredText(
      ownData(input, "resumeCondition", "resumeCondition"),
      "resumeCondition"
    ),
    schemaVersion: 1,
    status: terminalKind
  });
}

function canonicalTerminal(value: GoalActionTerminalReceipt): GoalActionTerminalReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("terminal receipt must be an object");
  }
  if (ownData(value, "schemaVersion", "terminal.schemaVersion") !== 1) {
    throw new Error("terminal receipt schemaVersion must be 1");
  }
  return createGoalActionTerminalReceipt({
    actionId: ownData(value, "actionId", "terminal.actionId") as string,
    blocker: ownData(value, "blocker", "terminal.blocker") as string,
    evidenceDigest: ownData(value, "evidenceDigest", "terminal.evidenceDigest") as string,
    resumeCondition: ownData(value, "resumeCondition", "terminal.resumeCondition") as string,
    terminalKind: ownData(value, "status", "terminal.status") as GoalActionTerminalKind
  });
}

/**
 * Admit only a changed, exact evidence digest to a later retry decision.
 * `retry-ready` is not execution authority; callers must pass later gates.
 */
export function assessGoalActionResume(
  terminal: GoalActionTerminalReceipt,
  input: { readonly evidenceDigest?: string }
): GoalActionResumeDecision {
  const canonical = canonicalTerminal(terminal);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("resume input must be an object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, "evidenceDigest");
  if (!descriptor) {
    if ("evidenceDigest" in input) {
      throw new Error("evidenceDigest must not be inherited");
    }
    return Object.freeze({
      decision: "held",
      reason: "missing-evidence",
      terminal: canonical
    });
  }
  if (!("value" in descriptor)) {
    throw new Error("evidenceDigest must be an own data property");
  }
  const nextDigest = digest(descriptor.value, "evidenceDigest");
  if (nextDigest === canonical.evidenceDigest) {
    return Object.freeze({
      decision: "held",
      reason: "unchanged-evidence",
      terminal: canonical
    });
  }
  return Object.freeze({
    actionId: canonical.actionId,
    decision: "retry-ready",
    evidenceDigest: nextDigest,
    previousEvidenceDigest: canonical.evidenceDigest,
    resumeCondition: canonical.resumeCondition
  });
}
