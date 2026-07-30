import { createHash } from "node:crypto";

import { assertPlainDataTree, type AgentLoopHealthInput } from "@muse/shared";

export type LoopKind = "adaptation" | "event" | "plan-execute" | "react" | "verification";

export type LoopTerminalState =
  | { readonly reason: "goal-verified"; readonly status: "completed" }
  | { readonly reason: "caller-cancelled"; readonly status: "cancelled" }
  | {
      readonly reason: "budget-exhausted" | "deadline-exceeded" | "execution-error" | "no-progress" | "verification-failed";
      readonly status: "failed";
    }
  | {
      readonly reason: "permission-required" | "retry-deferred" | "verification-pending";
      readonly status: "held";
    };

export type LoopVerification =
  | { readonly evidenceId: string; readonly status: "passed" }
  | { readonly status: "not-required" }
  | { readonly evidenceId: string; readonly status: "failed" }
  | { readonly status: "pending" };

export type LoopOutcomeVerificationVerdict =
  | { readonly evidenceId: string; readonly status: "passed" }
  | { readonly evidenceId: string; readonly status: "failed" };

export interface LoopBudgetCounterInput {
  readonly limit: number;
  readonly used: number;
}

export interface LoopBudgetCounter extends LoopBudgetCounterInput {
  readonly exhausted: boolean;
}

export interface LoopControlBudgetInput {
  readonly retries: LoopBudgetCounterInput | null;
  readonly steps: LoopBudgetCounterInput | null;
  readonly tools: LoopBudgetCounterInput | null;
  readonly wallclockLimitMs: number | null;
}

export interface LoopControlBudgetSnapshot {
  readonly retries: LoopBudgetCounter | null;
  readonly steps: LoopBudgetCounter | null;
  readonly tools: LoopBudgetCounter | null;
  readonly wallclock: {
    readonly elapsedMs: number;
    readonly exhausted: boolean;
    readonly limitMs: number | null;
  };
}

export interface CreateLoopControlReceiptInput {
  readonly budget: LoopControlBudgetInput;
  readonly endedAt: string;
  readonly loopKind: LoopKind;
  readonly runId: string;
  readonly startedAt: string;
  readonly terminal: LoopTerminalState;
  readonly verification: LoopVerification;
}

export interface LoopControlReceipt {
  readonly budget: LoopControlBudgetSnapshot;
  readonly endedAt: string;
  readonly loopKind: LoopKind;
  readonly receiptId: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly terminal: LoopTerminalState;
  readonly verification: LoopVerification;
}

const LOOP_KINDS = new Set<LoopKind>(["adaptation", "event", "plan-execute", "react", "verification"]);
const STATUS_REASONS = {
  cancelled: new Set(["caller-cancelled"]),
  completed: new Set(["goal-verified"]),
  failed: new Set(["budget-exhausted", "deadline-exceeded", "execution-error", "no-progress", "verification-failed"]),
  held: new Set(["permission-required", "retry-deferred", "verification-pending"])
} as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new Error(`${label} must not contain symbol keys`);
  }
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
  }
}

function assertFiniteNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function parseIso(value: unknown, label: string): { readonly iso: string; readonly ms: number } {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty ISO timestamp`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return { iso: value, ms };
}

function budgetCounter(input: LoopBudgetCounterInput | null, label: string): LoopBudgetCounter | null {
  if (input === null) return null;
  if (!isPlainRecord(input)) throw new Error(`${label} must be a plain object or null`);
  assertExactKeys(input, ["limit", "used"], label);
  assertFiniteNonNegativeInteger(input.limit, `${label}.limit`);
  assertFiniteNonNegativeInteger(input.used, `${label}.used`);
  if (input.limit === 0) {
    throw new Error(`${label}.limit must be greater than zero when the budget is enabled`);
  }
  return Object.freeze({ exhausted: input.used >= input.limit, limit: input.limit, used: input.used });
}

function normalizeTerminal(value: unknown): LoopTerminalState {
  if (!isPlainRecord(value)) throw new Error("terminal must be a plain object");
  assertExactKeys(value, ["reason", "status"], "terminal");
  if (value.status !== "cancelled" && value.status !== "completed" && value.status !== "failed" && value.status !== "held") {
    throw new Error("unsupported terminal status");
  }
  if (typeof value.reason !== "string" || !(STATUS_REASONS[value.status] as ReadonlySet<string>).has(value.reason)) {
    throw new Error(`terminal reason '${String(value.reason)}' is invalid for status '${value.status}'`);
  }
  return Object.freeze({ reason: value.reason, status: value.status } as LoopTerminalState);
}

function normalizeVerification(value: unknown): LoopVerification {
  if (!isPlainRecord(value)) throw new Error("verification must be a plain object");
  const ownKeys = Reflect.ownKeys(value);
  const hasEvidenceId = ownKeys.includes("evidenceId");
  assertExactKeys(value, hasEvidenceId ? ["evidenceId", "status"] : ["status"], "verification");
  const status = value.status;
  if (status === "passed" || status === "failed") {
    if (!hasEvidenceId) throw new Error("verification.evidenceId must be present");
    if (typeof value.evidenceId !== "string" || value.evidenceId.trim().length === 0) {
      throw new Error("verification.evidenceId must be non-empty");
    }
    return Object.freeze({ evidenceId: value.evidenceId, status });
  }
  if (hasEvidenceId) throw new Error("verification evidence is only valid for passed or failed status");
  if (status !== "pending" && status !== "not-required") {
    throw new Error("unsupported verification status");
  }
  return Object.freeze({ status });
}

function assertCrossFieldInvariants(
  terminal: LoopTerminalState,
  verification: LoopVerification,
  budget: LoopControlBudgetSnapshot
): void {
  if (terminal.status === "completed" && verification.status !== "passed" && verification.status !== "not-required") {
    throw new Error("completed loops require passed or explicitly not-required verification");
  }
  if (terminal.reason === "verification-failed" && verification.status !== "failed") {
    throw new Error("verification-failed termination requires failed verification evidence");
  }
  if (terminal.reason === "verification-pending" && verification.status !== "pending") {
    throw new Error("verification-pending termination requires pending verification");
  }
  if (
    terminal.reason === "budget-exhausted" &&
    ![budget.steps, budget.tools, budget.retries].some((counter) => counter?.exhausted)
  ) {
    throw new Error("budget-exhausted termination requires an exhausted step, tool, or retry budget");
  }
  if (terminal.reason === "deadline-exceeded" && !budget.wallclock.exhausted) {
    throw new Error("deadline-exceeded termination requires an exhausted wallclock budget");
  }
}

function receiptIdFor(body: Omit<LoopControlReceipt, "receiptId">): string {
  return `loop-control:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
}

export function createLoopControlReceipt(input: CreateLoopControlReceiptInput): LoopControlReceipt {
  if (!isPlainRecord(input)) throw new Error("loop control receipt input must be a plain object");
  assertExactKeys(
    input,
    ["budget", "endedAt", "loopKind", "runId", "startedAt", "terminal", "verification"],
    "loop control receipt input"
  );
  if (typeof input.runId !== "string" || input.runId.trim().length === 0) throw new Error("runId must be non-empty");
  if (!LOOP_KINDS.has(input.loopKind)) throw new Error(`unsupported loop kind: ${String(input.loopKind)}`);
  if (!isPlainRecord(input.budget)) throw new Error("budget must be a plain object");
  assertExactKeys(input.budget, ["retries", "steps", "tools", "wallclockLimitMs"], "budget");

  const started = parseIso(input.startedAt, "startedAt");
  const ended = parseIso(input.endedAt, "endedAt");
  if (ended.ms < started.ms) throw new Error("endedAt must not precede startedAt");

  const terminal = normalizeTerminal(input.terminal);
  const verification = normalizeVerification(input.verification);
  if (input.budget.wallclockLimitMs !== null) {
    assertFiniteNonNegativeInteger(input.budget.wallclockLimitMs, "budget.wallclockLimitMs");
    if (input.budget.wallclockLimitMs === 0) {
      throw new Error("budget.wallclockLimitMs must be greater than zero when enabled");
    }
  }

  const elapsedMs = ended.ms - started.ms;
  const budget: LoopControlBudgetSnapshot = Object.freeze({
    retries: budgetCounter(input.budget.retries, "budget.retries"),
    steps: budgetCounter(input.budget.steps, "budget.steps"),
    tools: budgetCounter(input.budget.tools, "budget.tools"),
    wallclock: Object.freeze({
      elapsedMs,
      exhausted: input.budget.wallclockLimitMs !== null && elapsedMs >= input.budget.wallclockLimitMs,
      limitMs: input.budget.wallclockLimitMs
    })
  });
  assertCrossFieldInvariants(terminal, verification, budget);

  const body: Omit<LoopControlReceipt, "receiptId"> = {
    budget,
    endedAt: ended.iso,
    loopKind: input.loopKind,
    runId: input.runId,
    schemaVersion: 1,
    startedAt: started.iso,
    terminal,
    verification
  };
  return Object.freeze({ ...body, receiptId: receiptIdFor(body) });
}

export function parseLoopControlReceipt(value: unknown): LoopControlReceipt {
  if (!isPlainRecord(value)) throw new Error("loop control receipt must be a plain object");
  assertExactKeys(
    value,
    ["budget", "endedAt", "loopKind", "receiptId", "runId", "schemaVersion", "startedAt", "terminal", "verification"],
    "loop control receipt"
  );
  if (value.schemaVersion !== 1) throw new Error("unsupported loop control receipt schemaVersion");
  if (typeof value.receiptId !== "string") throw new Error("receiptId must be a string");
  if (!isPlainRecord(value.budget)) throw new Error("budget must be a plain object");
  assertExactKeys(value.budget, ["retries", "steps", "tools", "wallclock"], "budget");
  if (!isPlainRecord(value.budget.wallclock)) throw new Error("budget.wallclock must be a plain object");
  assertExactKeys(value.budget.wallclock, ["elapsedMs", "exhausted", "limitMs"], "budget.wallclock");

  const parseCounter = (counter: unknown, label: string): LoopBudgetCounterInput | null => {
    if (counter === null) return null;
    if (!isPlainRecord(counter)) throw new Error(`${label} must be a plain object or null`);
    assertExactKeys(counter, ["exhausted", "limit", "used"], label);
    if (typeof counter.exhausted !== "boolean") throw new Error(`${label}.exhausted must be boolean`);
    assertFiniteNonNegativeInteger(counter.limit, `${label}.limit`);
    assertFiniteNonNegativeInteger(counter.used, `${label}.used`);
    if (counter.exhausted !== (counter.used >= counter.limit)) throw new Error(`${label}.exhausted is inconsistent`);
    return { limit: counter.limit, used: counter.used };
  };

  const terminal = normalizeTerminal(value.terminal);
  const verification = normalizeVerification(value.verification);
  if (typeof value.endedAt !== "string") throw new Error("endedAt must be a string");
  if (typeof value.startedAt !== "string") throw new Error("startedAt must be a string");
  if (typeof value.runId !== "string") throw new Error("runId must be a string");
  if (typeof value.loopKind !== "string" || !LOOP_KINDS.has(value.loopKind as LoopKind)) {
    throw new Error("unsupported loop kind");
  }
  const wallclockLimitMs = value.budget.wallclock.limitMs;
  if (wallclockLimitMs !== null) {
    assertFiniteNonNegativeInteger(wallclockLimitMs, "budget.wallclock.limitMs");
  }

  const candidate = createLoopControlReceipt({
    budget: {
      retries: parseCounter(value.budget.retries, "budget.retries"),
      steps: parseCounter(value.budget.steps, "budget.steps"),
      tools: parseCounter(value.budget.tools, "budget.tools"),
      wallclockLimitMs
    },
    endedAt: value.endedAt,
    loopKind: value.loopKind as LoopKind,
    runId: value.runId,
    startedAt: value.startedAt,
    terminal,
    verification
  });

  if (value.budget.wallclock.elapsedMs !== candidate.budget.wallclock.elapsedMs) {
    throw new Error("budget.wallclock.elapsedMs is inconsistent with timestamps");
  }
  if (value.budget.wallclock.exhausted !== candidate.budget.wallclock.exhausted) {
    throw new Error("budget.wallclock.exhausted is inconsistent");
  }
  if (value.receiptId !== candidate.receiptId) throw new Error("receiptId does not match receipt content");
  return candidate;
}

/**
 * Converts only a fully validated, content-bound receipt into supervisor input.
 * Invalid or hostile evidence is treated as absent instead of becoming health.
 */
export function projectLoopControlReceiptHealth(
  value: unknown
): AgentLoopHealthInput | undefined {
  try {
    assertPlainDataTree(value, "loop control receipt health evidence");
    const receipt = parseLoopControlReceipt(value);
    const verificationEvidenceId =
      receipt.verification.status === "passed" || receipt.verification.status === "failed"
        ? receipt.verification.evidenceId
        : undefined;
    return Object.freeze({
      endedAt: receipt.endedAt,
      terminalReason: receipt.terminal.reason,
      terminalStatus: receipt.terminal.status,
      ...(verificationEvidenceId === undefined ? {} : { verificationEvidenceId }),
      verificationStatus: receipt.verification.status
    });
  } catch {
    return undefined;
  }
}

export function settleLoopControlReceipt(
  receiptValue: unknown,
  verdictValue: unknown
): LoopControlReceipt {
  const receipt = parseLoopControlReceipt(receiptValue);
  if (
    receipt.terminal.status !== "held" ||
    receipt.terminal.reason !== "verification-pending" ||
    receipt.verification.status !== "pending"
  ) {
    throw new Error("only a verification-pending loop receipt can be settled");
  }
  const verification = normalizeVerification(verdictValue);
  if (verification.status !== "passed" && verification.status !== "failed") {
    throw new Error("loop outcome verdict must be passed or failed");
  }

  return createLoopControlReceipt({
    budget: {
      retries: receipt.budget.retries
        ? { limit: receipt.budget.retries.limit, used: receipt.budget.retries.used }
        : null,
      steps: receipt.budget.steps
        ? { limit: receipt.budget.steps.limit, used: receipt.budget.steps.used }
        : null,
      tools: receipt.budget.tools
        ? { limit: receipt.budget.tools.limit, used: receipt.budget.tools.used }
        : null,
      wallclockLimitMs: receipt.budget.wallclock.limitMs
    },
    endedAt: receipt.endedAt,
    loopKind: receipt.loopKind,
    runId: receipt.runId,
    startedAt: receipt.startedAt,
    terminal: verification.status === "passed"
      ? { reason: "goal-verified", status: "completed" }
      : { reason: "verification-failed", status: "failed" },
    verification
  });
}
