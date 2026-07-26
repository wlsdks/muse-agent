import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const RESIDENT_DAEMON_RESTART_STATE_VERSION = 1 as const;
export const RESIDENT_DAEMON_RESTART_MAX_FAILURE_THRESHOLD = 1_000;
export const RESIDENT_DAEMON_RESTART_MAX_TIMER_MS = 2_147_483_647;

export type ResidentDaemonRestartCircuitState = "closed" | "open" | "half-open";

export interface ResidentDaemonRestartPolicy {
  readonly baseDelayMs: number;
  readonly failureThreshold: number;
  readonly failureWindowMs: number;
  readonly maxDelayMs: number;
  readonly openCooldownMs: number;
}

export interface ResidentDaemonRestartStateReceipt {
  readonly admittedGeneration: string | null;
  readonly failureCount: number;
  readonly lastFailureAt: string | null;
  readonly lastFailureSequence: number;
  readonly notBeforeAt: string | null;
  readonly openedAt: string | null;
  readonly policy: ResidentDaemonRestartPolicy;
  readonly probeGeneration: string | null;
  readonly sequence: number;
  readonly state: ResidentDaemonRestartCircuitState;
  readonly successfulGeneration: string | null;
  readonly updatedAt: string;
  readonly version: typeof RESIDENT_DAEMON_RESTART_STATE_VERSION;
}

export type ResidentDaemonRestartAdmission =
  | { readonly state: "admit" }
  | { readonly delayMs: number; readonly state: "delay"; readonly until: string }
  | { readonly state: "half-open-probe" }
  | { readonly delayMs: number; readonly state: "open"; readonly until: string };

const RECEIPT_KEYS = [
  "admittedGeneration",
  "failureCount",
  "lastFailureAt",
  "lastFailureSequence",
  "notBeforeAt",
  "openedAt",
  "policy",
  "probeGeneration",
  "sequence",
  "state",
  "successfulGeneration",
  "updatedAt",
  "version"
] as const;
const POLICY_KEYS = [
  "baseDelayMs",
  "failureThreshold",
  "failureWindowMs",
  "maxDelayMs",
  "openCooldownMs"
] as const;

/** Shared path contract used by the restart controller and read-only health surfaces. */
export function resolveResidentDaemonRestartStateFilePath(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  if (!isAbsolute(home) || home.includes("\0")) return undefined;
  const ownerRoot = resolve(home);
  const override = env.MUSE_DAEMON_RESTART_STATE_FILE?.trim();
  if (override) {
    if (!isAbsolute(override) || override.includes("\0")) return undefined;
    const candidate = resolve(override);
    const fromOwner = relative(ownerRoot, candidate);
    return fromOwner !== ""
      && !fromOwner.startsWith(`..${sep}`)
      && fromOwner !== ".."
      && !isAbsolute(fromOwner)
      ? candidate
      : undefined;
  }
  return join(ownerRoot, ".muse", "resident-daemon-restart-state.json");
}

/** Reject owner-root escape and every existing symlink/non-owner directory component. */
export async function validateResidentDaemonRestartStatePath(
  env: Readonly<Record<string, string | undefined>>,
  file: string
): Promise<boolean> {
  const expected = resolveResidentDaemonRestartStateFilePath(env);
  if (expected === undefined || expected !== resolve(file)) return false;
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const ownerRoot = resolve(home);
  const parent = dirname(expected);
  const fromOwner = relative(ownerRoot, parent);
  if (fromOwner === ".." || fromOwner.startsWith(`..${sep}`) || isAbsolute(fromOwner)) return false;
  const components = fromOwner === "" ? [] : fromOwner.split(sep);
  let cursor = ownerRoot;
  for (const component of ["", ...components]) {
    if (component) cursor = join(cursor, component);
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
      if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) return false;
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
        return true;
      }
      return false;
    }
  }
  return true;
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(row).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value);
}

function canonicalTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

function nullableTime(value: unknown): number | null | undefined {
  return value === null ? null : canonicalTime(value);
}

function parsePolicy(value: unknown): ResidentDaemonRestartPolicy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(row, POLICY_KEYS)
    || !positiveSafeInteger(row.baseDelayMs)
    || !positiveSafeInteger(row.failureThreshold)
    || !positiveSafeInteger(row.failureWindowMs)
    || !positiveSafeInteger(row.maxDelayMs)
    || !positiveSafeInteger(row.openCooldownMs)
    || row.baseDelayMs > row.maxDelayMs
    || row.failureThreshold > RESIDENT_DAEMON_RESTART_MAX_FAILURE_THRESHOLD
    || row.failureWindowMs > RESIDENT_DAEMON_RESTART_MAX_TIMER_MS
    || row.maxDelayMs > RESIDENT_DAEMON_RESTART_MAX_TIMER_MS
    || row.openCooldownMs > RESIDENT_DAEMON_RESTART_MAX_TIMER_MS
  ) return undefined;
  return row as unknown as ResidentDaemonRestartPolicy;
}

export function parseResidentDaemonRestartStateReceipt(
  text: string
): ResidentDaemonRestartStateReceipt | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (!exactKeys(row, RECEIPT_KEYS)) return undefined;
    const policy = parsePolicy(row.policy);
    const updatedAt = canonicalTime(row.updatedAt);
    const lastFailureAt = nullableTime(row.lastFailureAt);
    const notBeforeAt = nullableTime(row.notBeforeAt);
    const openedAt = nullableTime(row.openedAt);
    if (
      row.version !== RESIDENT_DAEMON_RESTART_STATE_VERSION
      || (row.state !== "closed" && row.state !== "open" && row.state !== "half-open")
      || !nonNegativeSafeInteger(row.failureCount)
      || !nonNegativeSafeInteger(row.lastFailureSequence)
      || !positiveSafeInteger(row.sequence)
      || policy === undefined
      || updatedAt === undefined
      || lastFailureAt === undefined
      || notBeforeAt === undefined
      || openedAt === undefined
      || (row.admittedGeneration !== null && !validGeneration(row.admittedGeneration))
      || (row.probeGeneration !== null && !validGeneration(row.probeGeneration))
      || (row.successfulGeneration !== null && !validGeneration(row.successfulGeneration))
      || (lastFailureAt !== null && lastFailureAt > updatedAt)
      || row.failureCount > policy.failureThreshold
    ) return undefined;
    if (
      row.failureCount === 0
      && (
        row.lastFailureAt !== null
        || row.notBeforeAt !== null
      )
    ) {
      return undefined;
    }
    if (row.failureCount > 0 && (row.lastFailureAt === null || row.lastFailureSequence === 0)) {
      return undefined;
    }
    if (row.state === "closed") {
      if (row.openedAt !== null || row.probeGeneration !== null) return undefined;
      if (row.failureCount > 0 && row.successfulGeneration !== null) return undefined;
      if (row.successfulGeneration !== null && row.admittedGeneration === null) return undefined;
      if (
        row.successfulGeneration !== null
        && row.successfulGeneration !== row.admittedGeneration
      ) return undefined;
      if (row.failureCount > 0 && row.notBeforeAt === null) return undefined;
      if (
        row.admittedGeneration !== null
        && notBeforeAt !== null
        && notBeforeAt > updatedAt
      ) return undefined;
      if (lastFailureAt !== null && notBeforeAt !== null && notBeforeAt < lastFailureAt) {
        return undefined;
      }
    } else {
      if (
        row.failureCount === 0
        || openedAt === null
        || notBeforeAt === null
        || lastFailureAt === null
        || openedAt !== lastFailureAt
        || openedAt > updatedAt
        || notBeforeAt <= openedAt
        || row.admittedGeneration !== null
        || row.successfulGeneration !== null
      ) return undefined;
      if (row.state === "open" && row.probeGeneration !== null) return undefined;
      if (row.state === "half-open" && !validGeneration(row.probeGeneration)) return undefined;
    }
    return row as unknown as ResidentDaemonRestartStateReceipt;
  } catch {
    return undefined;
  }
}

function monotonicTime(now: Date, floor?: string): string {
  const observed = now.getTime();
  if (!Number.isFinite(observed)) throw new TypeError("invalid resident restart clock");
  return new Date(Math.max(observed, floor === undefined ? observed : Date.parse(floor))).toISOString();
}

function addMilliseconds(at: string, milliseconds: number): string {
  const next = Date.parse(at) + milliseconds;
  if (!Number.isSafeInteger(next)) throw new TypeError("resident restart deadline overflow");
  return new Date(next).toISOString();
}

function assertReceipt(receipt: ResidentDaemonRestartStateReceipt): ResidentDaemonRestartStateReceipt {
  if (!parseResidentDaemonRestartStateReceipt(JSON.stringify(receipt))) {
    throw new TypeError("invalid resident restart state");
  }
  return receipt;
}

export function beginResidentDaemonRestartState(
  policy: ResidentDaemonRestartPolicy,
  now: Date
): ResidentDaemonRestartStateReceipt {
  const updatedAt = monotonicTime(now);
  return assertReceipt({
    admittedGeneration: null,
    failureCount: 0,
    lastFailureAt: null,
    lastFailureSequence: 0,
    notBeforeAt: null,
    openedAt: null,
    policy,
    probeGeneration: null,
    sequence: 1,
    state: "closed",
    successfulGeneration: null,
    updatedAt,
    version: RESIDENT_DAEMON_RESTART_STATE_VERSION
  });
}

function exponentialDelay(policy: ResidentDaemonRestartPolicy, failureCount: number): number {
  let delay = policy.baseDelayMs;
  let remainingDoublings = Math.max(0, failureCount - 1);
  while (remainingDoublings > 0 && delay < policy.maxDelayMs) {
    delay = delay > Math.floor(policy.maxDelayMs / 2)
      ? policy.maxDelayMs
      : delay * 2;
    remainingDoublings -= 1;
  }
  return delay;
}

export function recordResidentDaemonRestartFailure(
  receipt: ResidentDaemonRestartStateReceipt,
  input: { readonly at: Date; readonly failureSequence: number }
): ResidentDaemonRestartStateReceipt {
  assertReceipt(receipt);
  if (!positiveSafeInteger(input.failureSequence)) {
    throw new TypeError("invalid resident terminal failure sequence");
  }
  if (input.failureSequence <= receipt.lastFailureSequence) return receipt;
  const updatedAt = monotonicTime(input.at, receipt.updatedAt);
  const previousFailureAt = receipt.lastFailureAt === null ? undefined : Date.parse(receipt.lastFailureAt);
  const withinWindow = previousFailureAt !== undefined
    && Date.parse(updatedAt) - previousFailureAt <= receipt.policy.failureWindowMs;
  const failureCount = withinWindow
    ? Math.min(receipt.policy.failureThreshold, receipt.failureCount + 1)
    : 1;
  const opens = receipt.state !== "closed" || failureCount >= receipt.policy.failureThreshold;
  return assertReceipt({
    ...receipt,
    admittedGeneration: null,
    failureCount,
    lastFailureAt: updatedAt,
    lastFailureSequence: input.failureSequence,
    notBeforeAt: addMilliseconds(
      updatedAt,
      opens ? receipt.policy.openCooldownMs : exponentialDelay(receipt.policy, failureCount)
    ),
    openedAt: opens ? updatedAt : null,
    probeGeneration: null,
    sequence: receipt.sequence + 1,
    state: opens ? "open" : "closed",
    successfulGeneration: null,
    updatedAt
  });
}

export function decideResidentDaemonRestartAdmission(
  receipt: ResidentDaemonRestartStateReceipt,
  input: { readonly generation: string; readonly now: Date }
): { readonly admission: ResidentDaemonRestartAdmission; readonly receipt: ResidentDaemonRestartStateReceipt } {
  assertReceipt(receipt);
  if (!validGeneration(input.generation)) throw new TypeError("invalid resident restart generation");
  const observedAt = monotonicTime(input.now, receipt.updatedAt);
  const deadline = receipt.notBeforeAt === null ? undefined : Date.parse(receipt.notBeforeAt);
  const remaining = deadline === undefined ? 0 : Math.max(0, deadline - Date.parse(observedAt));
  if (receipt.state === "closed") {
    if (remaining > 0) {
      return {
        admission: { delayMs: remaining, state: "delay", until: receipt.notBeforeAt! },
        receipt
      };
    }
    if (receipt.admittedGeneration === input.generation) {
      return { admission: { state: "admit" }, receipt };
    }
    const admitted = assertReceipt({
      ...receipt,
      admittedGeneration: input.generation,
      sequence: receipt.sequence + 1,
      successfulGeneration: null,
      updatedAt: observedAt
    });
    return { admission: { state: "admit" }, receipt: admitted };
  }
  if (receipt.state === "open" && remaining > 0) {
    return {
      admission: { delayMs: remaining, state: "open", until: receipt.notBeforeAt! },
      receipt
    };
  }
  if (receipt.state === "open") {
    const halfOpen = assertReceipt({
      ...receipt,
      probeGeneration: input.generation,
      sequence: receipt.sequence + 1,
      state: "half-open",
      updatedAt: observedAt
    });
    return { admission: { state: "half-open-probe" }, receipt: halfOpen };
  }
  if (receipt.probeGeneration !== input.generation) {
    const probeDeadline = addMilliseconds(receipt.updatedAt, receipt.policy.openCooldownMs);
    const probeRemaining = Math.max(0, Date.parse(probeDeadline) - Date.parse(observedAt));
    if (probeRemaining > 0) {
      return {
        admission: { delayMs: probeRemaining, state: "open", until: probeDeadline },
        receipt
      };
    }
    const reclaimed = assertReceipt({
      ...receipt,
      probeGeneration: input.generation,
      sequence: receipt.sequence + 1,
      updatedAt: observedAt
    });
    return { admission: { state: "half-open-probe" }, receipt: reclaimed };
  }
  return {
    admission: { state: "half-open-probe" },
    receipt
  };
}

export function recordResidentDaemonRestartSuccess(
  receipt: ResidentDaemonRestartStateReceipt,
  input: { readonly generation: string; readonly now: Date }
): ResidentDaemonRestartStateReceipt {
  assertReceipt(receipt);
  if (!validGeneration(input.generation)) throw new TypeError("invalid resident restart generation");
  if (receipt.state === "open") throw new TypeError("open resident restart circuit cannot succeed");
  if (receipt.state === "closed" && receipt.admittedGeneration !== input.generation) {
    throw new TypeError("resident restart admitted generation mismatch");
  }
  if (receipt.state === "half-open" && receipt.probeGeneration !== input.generation) {
    throw new TypeError("resident restart probe generation mismatch");
  }
  const updatedAt = monotonicTime(input.now, receipt.updatedAt);
  return assertReceipt({
    ...receipt,
    admittedGeneration: input.generation,
    failureCount: 0,
    lastFailureAt: null,
    notBeforeAt: null,
    openedAt: null,
    probeGeneration: null,
    sequence: receipt.sequence + 1,
    state: "closed",
    successfulGeneration: input.generation,
    updatedAt
  });
}

export function resetResidentDaemonRestartState(
  receipt: ResidentDaemonRestartStateReceipt,
  now: Date
): ResidentDaemonRestartStateReceipt {
  assertReceipt(receipt);
  const updatedAt = monotonicTime(now, receipt.updatedAt);
  return assertReceipt({
    ...receipt,
    admittedGeneration: null,
    failureCount: 0,
    lastFailureAt: null,
    notBeforeAt: null,
    openedAt: null,
    probeGeneration: null,
    sequence: receipt.sequence + 1,
    state: "closed",
    successfulGeneration: null,
    updatedAt
  });
}
