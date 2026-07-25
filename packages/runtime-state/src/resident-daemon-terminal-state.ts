import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const RESIDENT_DAEMON_TERMINAL_STATE_VERSION = 1 as const;
export const RESIDENT_DAEMON_FAILURE_HISTORY_LIMIT = 8;

export type ResidentDaemonFailureReasonCode =
  | "configuration-invalid"
  | "store-corrupt"
  | "provider-auth-failed"
  | "port-collision"
  | "uncaught-exception";

export type ResidentDaemonExitClass =
  | "configuration"
  | "data-integrity"
  | "authentication"
  | "resource-conflict"
  | "defect";

export type ResidentDaemonStablePoint =
  | "entry"
  | "configuration-loaded"
  | "writer-authority-acquired"
  | "heartbeat-established"
  | "runtime-initialized"
  | "tick-completed";

export interface ResidentDaemonFailureClassification {
  readonly exitClass: ResidentDaemonExitClass;
  readonly reasonCode: ResidentDaemonFailureReasonCode;
}

export interface ResidentDaemonFailureRecord extends ResidentDaemonFailureClassification {
  readonly at: string;
  readonly diagnosticRef: string;
  readonly generation: string;
  readonly id: string;
  readonly lastStablePoint: ResidentDaemonStablePoint;
  readonly pid: number;
  readonly sequence: number;
}

export interface ResidentDaemonTerminalStateReceipt {
  readonly failures: readonly ResidentDaemonFailureRecord[];
  readonly generation: string;
  readonly lastStableAt: string;
  readonly lastStablePoint: ResidentDaemonStablePoint;
  readonly pid: number;
  readonly sequence: number;
  readonly status: "running" | "failed";
  readonly updatedAt: string;
  readonly version: typeof RESIDENT_DAEMON_TERMINAL_STATE_VERSION;
}

export interface ResidentDaemonFailureContext {
  readonly domain?: "config" | "store" | "provider" | "runtime";
}

/** Shared path contract used by the resident writer and every read-only health surface. */
export function resolveResidentDaemonTerminalStateFilePath(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  if (!isAbsolute(home) || home.includes("\0")) return undefined;
  const ownerRoot = resolve(home);
  const override = env.MUSE_DAEMON_TERMINAL_STATE_FILE?.trim();
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
  return join(ownerRoot, ".muse", "resident-daemon-terminal-state.json");
}

/** Reject owner-root escape and every existing symlink/non-owner directory component. */
export async function validateResidentDaemonTerminalStatePath(
  env: Readonly<Record<string, string | undefined>>,
  file: string
): Promise<boolean> {
  const expected = resolveResidentDaemonTerminalStateFilePath(env);
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
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
        return true;
      }
      return false;
    }
  }
  return true;
}

const RECEIPT_KEYS = [
  "failures",
  "generation",
  "lastStableAt",
  "lastStablePoint",
  "pid",
  "sequence",
  "status",
  "updatedAt",
  "version"
] as const;
const FAILURE_KEYS = [
  "at",
  "diagnosticRef",
  "exitClass",
  "generation",
  "id",
  "lastStablePoint",
  "pid",
  "reasonCode",
  "sequence"
] as const;
const REASON_CODES: ReadonlySet<string> = new Set([
  "configuration-invalid",
  "store-corrupt",
  "provider-auth-failed",
  "port-collision",
  "uncaught-exception"
]);
const EXIT_CLASSES: ReadonlySet<string> = new Set([
  "configuration",
  "data-integrity",
  "authentication",
  "resource-conflict",
  "defect"
]);
const EXIT_CLASS_BY_REASON: Readonly<Record<
  ResidentDaemonFailureReasonCode,
  ResidentDaemonExitClass
>> = {
  "configuration-invalid": "configuration",
  "port-collision": "resource-conflict",
  "provider-auth-failed": "authentication",
  "store-corrupt": "data-integrity",
  "uncaught-exception": "defect"
};
const STABLE_POINTS: ReadonlySet<string> = new Set([
  "entry",
  "configuration-loaded",
  "writer-authority-acquired",
  "heartbeat-established",
  "runtime-initialized",
  "tick-completed"
]);
const STABLE_POINT_ORDER: Readonly<Record<ResidentDaemonStablePoint, number>> = {
  entry: 0,
  "configuration-loaded": 1,
  "writer-authority-acquired": 2,
  "heartbeat-established": 3,
  "runtime-initialized": 4,
  "tick-completed": 5
};

function exactKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(row).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/u.test(value);
}

function canonicalTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

function parseFailure(value: unknown): ResidentDaemonFailureRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, FAILURE_KEYS)) return undefined;
  if (
    canonicalTime(row.at) === undefined
    || !validId(row.id)
    || row.diagnosticRef !== `muse://resident-diagnostics/${row.id as string}`
    || !validToken(row.generation)
    || !positiveInteger(row.pid)
    || !positiveInteger(row.sequence)
    || typeof row.reasonCode !== "string"
    || !REASON_CODES.has(row.reasonCode)
    || typeof row.exitClass !== "string"
    || !EXIT_CLASSES.has(row.exitClass)
    || EXIT_CLASS_BY_REASON[row.reasonCode as ResidentDaemonFailureReasonCode] !== row.exitClass
    || typeof row.lastStablePoint !== "string"
    || !STABLE_POINTS.has(row.lastStablePoint)
  ) return undefined;
  return row as unknown as ResidentDaemonFailureRecord;
}

/** Strict parser for privacy-safe, owner-local resident failure evidence. */
export function parseResidentDaemonTerminalStateReceipt(
  text: string
): ResidentDaemonTerminalStateReceipt | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    if (!exactKeys(row, RECEIPT_KEYS)) return undefined;
    const updatedAt = canonicalTime(row.updatedAt);
    const lastStableAt = canonicalTime(row.lastStableAt);
    if (
      row.version !== RESIDENT_DAEMON_TERMINAL_STATE_VERSION
      || !validToken(row.generation)
      || !positiveInteger(row.pid)
      || !positiveInteger(row.sequence)
      || (row.status !== "running" && row.status !== "failed")
      || typeof row.lastStablePoint !== "string"
      || !STABLE_POINTS.has(row.lastStablePoint)
      || updatedAt === undefined
      || lastStableAt === undefined
      || lastStableAt > updatedAt
      || !Array.isArray(row.failures)
      || row.failures.length > RESIDENT_DAEMON_FAILURE_HISTORY_LIMIT
    ) return undefined;
    const failures = row.failures.map(parseFailure);
    if (failures.some((failure) => failure === undefined)) return undefined;
    let previousSequence = 0;
    for (const failure of failures as ResidentDaemonFailureRecord[]) {
      const at = Date.parse(failure.at);
      if (failure.sequence <= previousSequence || failure.sequence > row.sequence || at > updatedAt) {
        return undefined;
      }
      previousSequence = failure.sequence;
    }
    const latest = failures.at(-1);
    if (
      row.status === "failed"
      && (
        latest === undefined
        || latest.generation !== row.generation
        || latest.pid !== row.pid
        || latest.sequence !== row.sequence
      )
    ) return undefined;
    if (
      row.status === "running"
      && (failures as ResidentDaemonFailureRecord[]).some((failure) =>
        failure.generation === row.generation && failure.pid === row.pid)
    ) return undefined;
    return row as unknown as ResidentDaemonTerminalStateReceipt;
  } catch {
    return undefined;
  }
}

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  const code = (cause as { readonly code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

function errorStatus(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  for (const key of ["status", "statusCode"] as const) {
    if (key in cause) {
      const value = (cause as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    }
  }
  return undefined;
}

/** Classify without retaining the thrown message, stack, path, or credentials. */
export function classifyResidentDaemonFailure(
  cause: unknown,
  context: ResidentDaemonFailureContext = {}
): ResidentDaemonFailureClassification {
  const code = errorCode(cause);
  if (code === "EADDRINUSE") {
    return { exitClass: "resource-conflict", reasonCode: "port-collision" };
  }
  if (
    errorStatus(cause) === 401
    || errorStatus(cause) === 403
    || code === "EAUTH"
    || code === "AUTH_FAILED"
    || code === "UNAUTHORIZED"
  ) {
    return { exitClass: "authentication", reasonCode: "provider-auth-failed" };
  }
  if (
    code === "SQLITE_CORRUPT"
    || code === "SQLITE_NOTADB"
    || code === "ERR_STORE_CORRUPT"
    || (context.domain === "runtime" && cause instanceof SyntaxError)
  ) {
    return { exitClass: "data-integrity", reasonCode: "store-corrupt" };
  }
  if (context.domain === "config") {
    return { exitClass: "configuration", reasonCode: "configuration-invalid" };
  }
  if (context.domain === "store") {
    return { exitClass: "data-integrity", reasonCode: "store-corrupt" };
  }
  return { exitClass: "defect", reasonCode: "uncaught-exception" };
}

function monotonicTime(now: Date, floor: string | undefined): string {
  const observed = now.getTime();
  if (!Number.isFinite(observed)) throw new TypeError("invalid resident terminal-state clock");
  return new Date(Math.max(observed, floor === undefined ? observed : Date.parse(floor))).toISOString();
}

export function beginResidentDaemonTerminalGeneration(input: {
  readonly generation: string;
  readonly now: Date;
  readonly pid: number;
  readonly previous?: ResidentDaemonTerminalStateReceipt;
}): ResidentDaemonTerminalStateReceipt {
  const updatedAt = monotonicTime(input.now, input.previous?.updatedAt);
  const receipt: ResidentDaemonTerminalStateReceipt = {
    failures: input.previous?.failures ?? [],
    generation: input.generation,
    lastStableAt: updatedAt,
    lastStablePoint: "entry",
    pid: input.pid,
    sequence: (input.previous?.sequence ?? 0) + 1,
    status: "running",
    updatedAt,
    version: RESIDENT_DAEMON_TERMINAL_STATE_VERSION
  };
  if (!parseResidentDaemonTerminalStateReceipt(JSON.stringify(receipt))) {
    throw new TypeError("invalid resident terminal-state generation");
  }
  return receipt;
}

export function markResidentDaemonStable(
  receipt: ResidentDaemonTerminalStateReceipt,
  stablePoint: ResidentDaemonStablePoint,
  now: Date
): ResidentDaemonTerminalStateReceipt {
  if (receipt.status === "failed") {
    throw new TypeError("resident terminal failure is final for its generation");
  }
  if (STABLE_POINT_ORDER[stablePoint] < STABLE_POINT_ORDER[receipt.lastStablePoint]) {
    throw new TypeError("resident terminal stable point cannot regress");
  }
  const updatedAt = monotonicTime(now, receipt.updatedAt);
  const next: ResidentDaemonTerminalStateReceipt = {
    ...receipt,
    lastStableAt: updatedAt,
    lastStablePoint: stablePoint,
    sequence: receipt.sequence + 1,
    status: "running",
    updatedAt
  };
  if (!parseResidentDaemonTerminalStateReceipt(JSON.stringify(next))) {
    throw new TypeError("invalid resident terminal stable point");
  }
  return next;
}

export function appendResidentDaemonFailure(
  receipt: ResidentDaemonTerminalStateReceipt,
  input: {
    readonly cause: unknown;
    readonly context?: ResidentDaemonFailureContext;
    readonly id: string;
    readonly now: Date;
  }
): ResidentDaemonTerminalStateReceipt {
  if (!validId(input.id)) throw new TypeError("invalid resident diagnostic id");
  const updatedAt = monotonicTime(input.now, receipt.updatedAt);
  const sequence = receipt.sequence + 1;
  const failure: ResidentDaemonFailureRecord = {
    at: updatedAt,
    ...classifyResidentDaemonFailure(input.cause, input.context),
    diagnosticRef: `muse://resident-diagnostics/${input.id}`,
    generation: receipt.generation,
    id: input.id,
    lastStablePoint: receipt.lastStablePoint,
    pid: receipt.pid,
    sequence
  };
  const next: ResidentDaemonTerminalStateReceipt = {
    ...receipt,
    failures: [...receipt.failures, failure].slice(-RESIDENT_DAEMON_FAILURE_HISTORY_LIMIT),
    sequence,
    status: "failed",
    updatedAt
  };
  if (!parseResidentDaemonTerminalStateReceipt(JSON.stringify(next))) {
    throw new TypeError("invalid resident terminal failure");
  }
  return next;
}
