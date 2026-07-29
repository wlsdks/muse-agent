import { isAbsolute, resolve } from "node:path";

const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_TEXT_LENGTH = 10_000;
const MAX_LIST_ITEMS = 100;

export interface DelegationSubtaskHandoff {
  readonly allowedToolNames: readonly string[];
  readonly dependsOn: readonly string[];
  readonly effectScopes: readonly string[];
  readonly expiresAt: string;
  readonly id: string;
  readonly input: string;
  readonly outputSchema: string;
  readonly role: string;
  readonly writablePaths: readonly string[];
}

export interface DelegationHandoff {
  readonly contextIndependent: boolean;
  readonly decomposition: "single" | "serial" | "fanout";
  readonly mergeable: boolean;
  readonly objective: string;
  readonly schemaVersion: 1;
  readonly sharedState: boolean;
  readonly subtasks: readonly DelegationSubtaskHandoff[];
}

export type DelegationHandoffAdmission =
  | { readonly ok: true; readonly handoff: DelegationHandoff }
  | { readonly ok: false; readonly reason: string };

export interface BoundDelegationSubtaskScope {
  readonly allowedToolNames: readonly string[];
  readonly expiresAt: string;
  readonly writablePaths: readonly string[];
}

declare const delegationHandoffLeaseBrand: unique symbol;

/**
 * Opaque, process-local authority to start exactly one admitted delegated
 * subtask. Serialization and object cloning deliberately destroy the grant.
 */
export interface DelegationHandoffLease {
  readonly [delegationHandoffLeaseBrand]: true;
}

interface DelegationHandoffLeaseRecord {
  consumed: boolean;
  readonly scope: BoundDelegationSubtaskScope;
}

const delegationHandoffLeaseRecords = new WeakMap<object, DelegationHandoffLeaseRecord>();

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new Error(`${label} exceeds the ${MAX_TEXT_LENGTH.toString()}-character cap`);
  }
  return normalized;
}

function stringList(value: unknown, label: string, pattern?: RegExp): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${label} must be an array with at most ${MAX_LIST_ITEMS.toString()} items`);
  }
  const normalized = value.map((item, index) => {
    const text = requiredText(item, `${label}[${index.toString()}]`);
    if (pattern && !pattern.test(text)) throw new Error(`${label}[${index.toString()}] is invalid`);
    return text;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicates`);
  return Object.freeze(normalized);
}

function writablePath(value: unknown, label: string): string {
  const path = requiredText(value, label).normalize("NFC").replaceAll("\\", "/");
  const parts = path.split("/");
  if (
    path.startsWith("/")
    || path.startsWith("~")
    || /^[A-Za-z]:\//u.test(path)
    || parts.some((part) =>
      part === ""
      || part === "."
      || part === ".."
      || part.endsWith(".")
      || part.endsWith(" ")
      || /[<>:"|?*\u0000-\u001F]/u.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part)
    )
  ) {
    throw new Error(`${label} must be a normalized workspace-relative path`);
  }
  return path;
}

function writablePaths(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${label} must be an array with at most ${MAX_LIST_ITEMS.toString()} items`);
  }
  const normalized = value.map((item, index) => writablePath(item, `${label}[${index.toString()}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicates`);
  return Object.freeze(normalized);
}

function pathsOverlap(left: string, right: string): boolean {
  const comparableLeft = left.toLowerCase();
  const comparableRight = right.toLowerCase();
  return comparableLeft === comparableRight
    || comparableLeft.startsWith(`${comparableRight}/`)
    || comparableRight.startsWith(`${comparableLeft}/`);
}

function parseTimestamp(value: unknown, label: string): string {
  const timestamp = requiredText(value, label);
  const parsed = Date.parse(timestamp);
  if (
    !UTC_TIMESTAMP.test(timestamp)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== timestamp
  ) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
  return timestamp;
}

/**
 * Validate and freeze the one worker handoff contract used at the fan-out seam.
 * This is admission only: writable-path enforcement belongs at the concrete
 * filesystem/runner boundary and must not be inferred from this declaration.
 */
export function assessDelegationFanout(
  value: unknown,
  expectedSubtaskIds: readonly string[],
  nowIso: string
): DelegationHandoffAdmission {
  try {
    if (!value || typeof value !== "object") throw new Error("handoff must be an object");
    const candidate = value as Record<string, unknown>;
    if (candidate.schemaVersion !== 1) throw new Error("handoff schemaVersion must be 1");
    if (candidate.decomposition !== "fanout") throw new Error("handoff decomposition must be fanout");
    if (candidate.sharedState !== false) throw new Error("fan-out requires sharedState=false");
    if (candidate.contextIndependent !== true) throw new Error("fan-out requires contextIndependent=true");
    if (candidate.mergeable !== true) throw new Error("fan-out requires mergeable=true");
    const nowMs = Date.parse(parseTimestamp(nowIso, "nowIso"));
    if (!Array.isArray(candidate.subtasks) || candidate.subtasks.length < 2) {
      throw new Error("fan-out requires at least two subtasks");
    }

    const subtasks = candidate.subtasks.map((raw, index): DelegationSubtaskHandoff => {
      if (!raw || typeof raw !== "object") throw new Error(`subtasks[${index.toString()}] must be an object`);
      const subtask = raw as Record<string, unknown>;
      const id = requiredText(subtask.id, `subtasks[${index.toString()}].id`);
      if (!HANDOFF_ID.test(id)) throw new Error(`subtasks[${index.toString()}].id is invalid`);
      const expiresAt = parseTimestamp(subtask.expiresAt, `subtasks[${index.toString()}].expiresAt`);
      if (Date.parse(expiresAt) <= nowMs) throw new Error(`subtask '${id}' handoff is expired`);
      const dependsOn = stringList(subtask.dependsOn, `subtasks[${index.toString()}].dependsOn`, HANDOFF_ID);
      if (dependsOn.length > 0) throw new Error(`subtask '${id}' has ordered dependencies`);
      const effectScopes = stringList(subtask.effectScopes, `subtasks[${index.toString()}].effectScopes`);
      if (effectScopes.length > 0) throw new Error(`subtask '${id}' declares effects and cannot fan out`);
      return Object.freeze({
        allowedToolNames: stringList(subtask.allowedToolNames, `subtasks[${index.toString()}].allowedToolNames`, TOOL_NAME),
        dependsOn,
        effectScopes,
        expiresAt,
        id,
        input: requiredText(subtask.input, `subtasks[${index.toString()}].input`),
        outputSchema: requiredText(subtask.outputSchema, `subtasks[${index.toString()}].outputSchema`),
        role: requiredText(subtask.role, `subtasks[${index.toString()}].role`),
        writablePaths: writablePaths(subtask.writablePaths, `subtasks[${index.toString()}].writablePaths`)
      });
    });

    const actualIds = subtasks.map((subtask) => subtask.id);
    if (
      actualIds.length !== expectedSubtaskIds.length
      || actualIds.some((id, index) => id !== expectedSubtaskIds[index])
      || new Set(actualIds).size !== actualIds.length
    ) {
      throw new Error("handoff subtasks must exactly match the requested expansion order");
    }

    const claimedPaths: Array<{ readonly owner: string; readonly path: string }> = [];
    for (const subtask of subtasks) {
      for (const path of subtask.writablePaths) {
        const conflict = claimedPaths.find((claim) => pathsOverlap(claim.path, path));
        if (conflict) {
          throw new Error(`writable path '${path}' for '${subtask.id}' overlaps '${conflict.path}' for '${conflict.owner}'`);
        }
        claimedPaths.push({ owner: subtask.id, path });
      }
    }

    return {
      handoff: Object.freeze({
        contextIndependent: true,
        decomposition: "fanout",
        mergeable: true,
        objective: requiredText(candidate.objective, "objective"),
        schemaVersion: 1,
        sharedState: false,
        subtasks: Object.freeze(subtasks)
      }),
      ok: true
    };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Bind one admitted relative handoff scope to a trusted absolute workspace root. */
export function bindDelegationSubtaskScope(
  handoff: DelegationHandoff,
  subtaskId: string,
  workspaceRoot: string,
  nowIso: string
): BoundDelegationSubtaskScope {
  const admission = assessDelegationFanout(handoff, handoff.subtasks.map((subtask) => subtask.id), nowIso);
  if (!admission.ok) throw new Error(`delegation handoff rejected: ${admission.reason}`);
  if (!isAbsolute(workspaceRoot)) throw new Error("workspaceRoot must be absolute");
  const subtask = admission.handoff.subtasks.find((candidate) => candidate.id === subtaskId);
  if (!subtask) throw new Error(`delegation handoff has no subtask '${subtaskId}'`);
  const root = resolve(workspaceRoot);
  return Object.freeze({
    allowedToolNames: subtask.allowedToolNames,
    expiresAt: subtask.expiresAt,
    writablePaths: Object.freeze(subtask.writablePaths.map((path) => resolve(root, path)))
  });
}

/**
 * Mint one process-local, one-shot execution lease after handoff admission.
 * The inspectable handoff remains a proposal; only this opaque token can cross
 * the worker-start gate.
 */
export function createDelegationHandoffLease(
  handoff: DelegationHandoff,
  subtaskId: string,
  workspaceRoot: string,
  nowIso: string
): DelegationHandoffLease {
  const scope = bindDelegationSubtaskScope(handoff, subtaskId, workspaceRoot, nowIso);
  const lease = Object.freeze({}) as DelegationHandoffLease;
  delegationHandoffLeaseRecords.set(lease, { consumed: false, scope });
  return lease;
}

/** Resolve a genuine unconsumed lease for worker construction without consuming it. */
export function inspectDelegationHandoffLease(value: unknown): BoundDelegationSubtaskScope {
  if (!value || typeof value !== "object") {
    throw new Error("delegation handoff lease is invalid or forged");
  }
  const record = delegationHandoffLeaseRecords.get(value);
  if (!record) throw new Error("delegation handoff lease is invalid or forged");
  if (record.consumed) throw new Error("delegation handoff lease was already consumed");
  if (Date.parse(record.scope.expiresAt) <= Date.now()) {
    throw new Error("delegation handoff lease is expired");
  }
  return record.scope;
}

/**
 * Atomically consume a genuine lease immediately before worker start.
 * There is no await between marking it consumed and returning its bound scope.
 */
export function consumeDelegationHandoffLease(value: unknown): BoundDelegationSubtaskScope {
  const scope = inspectDelegationHandoffLease(value);
  const record = delegationHandoffLeaseRecords.get(value as object);
  if (!record) throw new Error("delegation handoff lease is invalid or forged");
  record.consumed = true;
  return scope;
}
