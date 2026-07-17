/**
 * Pending channel-approval store.
 *
 * When `createChannelApprovalGate` refuses a risky tool an inbound
 * channel message triggered, the action is recorded here as a PENDING
 * approval: a live, dismissable, auto-expiring worklist of "things Muse
 * wanted to do remotely and is waiting on you for". Distinct from the
 * action log (`personal-action-log-store`), which is the immutable audit
 * trail of every action ever attempted — this store holds only the
 * un-actioned, un-expired items, with the structured `tool` + `arguments`
 * needed to re-run them once an approval lands (the approve-completion
 * round-trip).
 *
 * Pure data layer (no `@muse/agent-core` / `@muse/mcp` dependency):
 * tolerant display reads, strict fail-closed mutations, atomic writes.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { atomicWritePrivateFile, withMessagingFileMutation } from "./messaging-file-store.js";

export interface PendingApproval {
  readonly id: string;
  /** Tool the agent attempted (e.g. "email_send"). */
  readonly tool: string;
  readonly risk: "write" | "execute";
  /** Human-readable draft shown for confirmation. */
  readonly draft: string;
  /** Structured args to re-run the tool when approved. */
  readonly arguments: Record<string, unknown>;
  readonly providerId: string;
  readonly source: string;
  readonly userId?: string;
  /** ISO timestamp the refusal was recorded. */
  readonly createdAt: string;
  /** ISO timestamp after which this pending approval is stale. */
  readonly expiresAt: string;
}

export type PendingApprovalExecutionState = "claimed" | "executing" | "succeeded" | "unknown" | "denied";

export interface PendingApprovalExecution {
  readonly approvalSnapshot: PendingApproval;
  readonly claimToken: string;
  readonly actor: {
    readonly surface: "api" | "cli";
    readonly effectiveUser: string;
  };
  readonly state: PendingApprovalExecutionState;
  readonly claimedAt: string;
  readonly updatedAt: string;
  readonly detail?: string;
}

interface PendingApprovalStoreV2 {
  readonly version: 2;
  readonly pending: readonly PendingApproval[];
  readonly executions: readonly PendingApprovalExecution[];
}

export type PendingApprovalClaimResult =
  | {
      readonly claimedByThisCall: true;
      readonly state: "claimed";
      readonly claimToken: string;
      readonly approvalSnapshot: PendingApproval;
    }
  | {
      readonly claimedByThisCall: false;
      readonly state: PendingApprovalExecutionState | "not-found" | "expired" | "forbidden";
    };

export interface PendingApprovalTransitionResult {
  readonly transitioned: boolean;
  readonly state: PendingApprovalExecutionState | "not-found" | "expired" | "forbidden";
}

export type PendingApprovalDenyResult =
  | {
      readonly transitioned: true;
      readonly state: "denied";
      readonly approvalSnapshot: PendingApproval;
    }
  | {
      readonly transitioned: false;
      readonly state: PendingApprovalExecutionState | "not-found" | "expired" | "forbidden";
    };

const PENDING_APPROVAL_MAX_ENTRIES = 200;

function isPendingApproval(value: unknown): value is PendingApproval {
  if (!value || typeof value !== "object") {
    return false;
  }
  const e = value as Record<string, unknown>;
  return (
    typeof e["id"] === "string"
    && typeof e["tool"] === "string"
    && (e["risk"] === "write" || e["risk"] === "execute")
    && typeof e["draft"] === "string"
    && typeof e["arguments"] === "object" && e["arguments"] !== null && !Array.isArray(e["arguments"])
    && typeof e["providerId"] === "string"
    && typeof e["source"] === "string"
    && typeof e["createdAt"] === "string"
    && typeof e["expiresAt"] === "string"
    && (e["userId"] === undefined || typeof e["userId"] === "string")
  );
}

function isStrictPendingApproval(value: unknown): value is PendingApproval {
  return isPendingApproval(value)
    && Number.isFinite(Date.parse(value.createdAt))
    && Number.isFinite(Date.parse(value.expiresAt));
}

function isExactNewPendingApproval(value: unknown): value is PendingApproval {
  return isStrictPendingApproval(value)
    && Date.parse(value.createdAt) < Date.parse(value.expiresAt)
    && Object.keys(value).every((key) => key === "id" || key === "tool" || key === "risk" || key === "draft" || key === "arguments" || key === "providerId" || key === "source" || key === "userId" || key === "createdAt" || key === "expiresAt");
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPendingApprovalExecution(value: unknown): value is PendingApprovalExecution {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const actor = record["actor"];
  const actorRecord = actor as Record<string, unknown>;
  const approvalSnapshot = record["approvalSnapshot"];
  return isStrictPendingApproval(approvalSnapshot)
    && Object.keys(record).every((key) => key === "approvalSnapshot" || key === "claimToken" || key === "actor" || key === "state" || key === "claimedAt" || key === "updatedAt" || key === "detail")
    && isUuid(record["claimToken"])
    && Boolean(actor) && typeof actor === "object"
    && Object.keys(actorRecord).length === 2
    && Object.keys(actorRecord).every((key) => key === "surface" || key === "effectiveUser")
    && (actorRecord["surface"] === "api" || actorRecord["surface"] === "cli")
    && typeof actorRecord["effectiveUser"] === "string"
    && actorRecord["effectiveUser"].trim().length > 0
    && (approvalSnapshot.userId !== undefined
      ? actorRecord["effectiveUser"] === approvalSnapshot.userId
      : actorRecord["surface"] === "cli"
        ? actorRecord["effectiveUser"] === `${approvalSnapshot.providerId}:${approvalSnapshot.source}`
        : true)
    && (record["state"] === "claimed" || record["state"] === "executing" || record["state"] === "succeeded" || record["state"] === "unknown" || record["state"] === "denied")
    && isIsoTimestamp(record["claimedAt"])
    && isIsoTimestamp(record["updatedAt"])
    && Date.parse(approvalSnapshot.createdAt) <= Date.parse(record["claimedAt"])
    && Date.parse(record["claimedAt"]) < Date.parse(approvalSnapshot.expiresAt)
    && Date.parse(record["claimedAt"]) <= Date.parse(record["updatedAt"])
    && (record["detail"] === undefined || typeof record["detail"] === "string");
}

function isPendingApprovalStoreV2(value: unknown): value is PendingApprovalStoreV2 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record["version"] !== 2
    || Object.keys(record).some((key) => key !== "version" && key !== "pending" && key !== "executions")
    || !Array.isArray(record["pending"])
    || !record["pending"].every(isStrictPendingApproval)
    || !Array.isArray(record["executions"])
    || !record["executions"].every(isPendingApprovalExecution)) {
    return false;
  }
  const ids = [
    ...record["pending"].map((entry) => entry.id),
    ...record["executions"].map((execution) => execution.approvalSnapshot.id)
  ];
  const claimTokens = record["executions"].map((execution) => execution.claimToken);
  return new Set(ids).size === ids.length && new Set(claimTokens).size === claimTokens.length;
}

async function readMutationStore(file: string): Promise<PendingApprovalStoreV2 | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (cause) {
    if (cause && typeof cause === "object" && (cause as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw cause;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid pending approval store");
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record["pending"]) || !record["pending"].every(isStrictPendingApproval)) {
    throw new Error("invalid pending approval store");
  }
  if (record["version"] === undefined) {
    if (Object.keys(record).some((key) => key !== "pending")) {
      throw new Error("invalid pending approval store v1");
    }
    return { executions: [], pending: record["pending"], version: 2 };
  }
  if (!isPendingApprovalStoreV2(record)) {
    throw new Error("invalid pending approval store version");
  }
  return { executions: record["executions"], pending: record["pending"], version: 2 };
}

async function writePendingApprovalStore(file: string, store: PendingApprovalStoreV2): Promise<void> {
  if (!isPendingApprovalStoreV2(store)) {
    throw new Error("invalid pending approval store candidate");
  }
  await atomicWritePrivateFile(file, `${JSON.stringify(store, null, 2)}\n`);
}

/** Atomically acquire execution authority for one pending approval. */
export async function claimPendingApproval(
  file: string,
  id: string,
  actor: { readonly surface: "api"; readonly requestUserId?: string } | { readonly surface: "cli" },
  now: () => Date = () => new Date()
): Promise<PendingApprovalClaimResult> {
  return serializePerFile(file, async () => {
    const store = await readMutationStore(file);
    if (!store) {
      return { claimedByThisCall: false, state: "not-found" };
    }
    const prior = store.executions.find((execution) => execution.approvalSnapshot.id === id);
    if (prior) {
      return { claimedByThisCall: false, state: prior.state };
    }
    const approval = store.pending.find((entry) => entry.id === id);
    if (!approval) {
      return { claimedByThisCall: false, state: "not-found" };
    }
    const instant = now();
    if (Date.parse(approval.expiresAt) <= instant.getTime()) {
      return { claimedByThisCall: false, state: "expired" };
    }
    const requestUserId = actor.surface === "api" ? actor.requestUserId : undefined;
    if (approval.userId !== undefined && requestUserId !== undefined && approval.userId !== requestUserId) {
      return { claimedByThisCall: false, state: "forbidden" };
    }
    const timestamp = instant.toISOString();
    const claimToken = randomUUID();
    const effectiveUser = actor.surface === "api"
      ? requestUserId ?? approval.userId ?? `${approval.providerId}:${approval.source}`
      : approval.userId ?? `${approval.providerId}:${approval.source}`;
    const execution: PendingApprovalExecution = {
      actor: { effectiveUser, surface: actor.surface },
      approvalSnapshot: approval,
      claimedAt: timestamp,
      claimToken,
      state: "claimed",
      updatedAt: timestamp
    };
    await writePendingApprovalStore(file, {
      executions: [...store.executions, execution],
      pending: store.pending.filter((entry) => entry.id !== id),
      version: 2
    });
    return { approvalSnapshot: approval, claimedByThisCall: true, claimToken, state: "claimed" };
  });
}

export async function denyPendingApproval(
  file: string,
  id: string,
  actor: { readonly surface: "api"; readonly requestUserId?: string } | { readonly surface: "cli" },
  detail?: string,
  now: () => Date = () => new Date()
): Promise<PendingApprovalDenyResult> {
  return serializePerFile(file, async () => {
    const store = await readMutationStore(file);
    if (!store) {
      return { state: "not-found", transitioned: false };
    }
    const prior = store.executions.find((execution) => execution.approvalSnapshot.id === id);
    if (prior) {
      return { state: prior.state, transitioned: false };
    }
    const approval = store.pending.find((entry) => entry.id === id);
    if (!approval) {
      return { state: "not-found", transitioned: false };
    }
    const instant = now();
    if (Date.parse(approval.expiresAt) <= instant.getTime()) {
      return { state: "expired", transitioned: false };
    }
    const requestUserId = actor.surface === "api" ? actor.requestUserId : undefined;
    if (approval.userId !== undefined && requestUserId !== undefined && approval.userId !== requestUserId) {
      return { state: "forbidden", transitioned: false };
    }
    const effectiveUser = actor.surface === "api"
      ? requestUserId ?? approval.userId ?? `${approval.providerId}:${approval.source}`
      : approval.userId ?? `${approval.providerId}:${approval.source}`;
    const timestamp = instant.toISOString();
    const execution: PendingApprovalExecution = {
      actor: { effectiveUser, surface: actor.surface },
      approvalSnapshot: approval,
      claimedAt: timestamp,
      claimToken: randomUUID(),
      ...(detail === undefined ? {} : { detail }),
      state: "denied",
      updatedAt: timestamp
    };
    await writePendingApprovalStore(file, {
      executions: [...store.executions, execution],
      pending: store.pending.filter((entry) => entry.id !== id),
      version: 2
    });
    return { approvalSnapshot: approval, state: "denied", transitioned: true };
  });
}

async function transitionPendingApprovalExecution(
  file: string,
  id: string,
  claimToken: string,
  from: PendingApprovalExecutionState,
  to: PendingApprovalExecutionState,
  detail: string | undefined,
  now: () => Date
): Promise<PendingApprovalTransitionResult> {
  return serializePerFile(file, async () => {
    const store = await readMutationStore(file);
    const index = store?.executions.findIndex((execution) => execution.approvalSnapshot.id === id) ?? -1;
    if (!store || index < 0) {
      return { state: "not-found", transitioned: false };
    }
    const current = store.executions[index]!;
    if (current.claimToken !== claimToken || current.state !== from) {
      return { state: current.state, transitioned: false };
    }
    const updated: PendingApprovalExecution = {
      ...current,
      ...(detail === undefined ? {} : { detail }),
      state: to,
      updatedAt: new Date(Math.max(
        Date.parse(current.claimedAt),
        Date.parse(current.updatedAt),
        now().getTime()
      )).toISOString()
    };
    const executions = store.executions.slice();
    executions[index] = updated;
    await writePendingApprovalStore(file, { ...store, executions });
    return { state: to, transitioned: true };
  });
}

export async function beginPendingApprovalExecution(
  file: string,
  id: string,
  claimToken: string,
  now: () => Date = () => new Date()
): Promise<PendingApprovalTransitionResult> {
  return transitionPendingApprovalExecution(file, id, claimToken, "claimed", "executing", undefined, now);
}

export async function declinePendingApprovalClaim(
  file: string,
  id: string,
  claimToken: string,
  detail?: string,
  now: () => Date = () => new Date()
): Promise<PendingApprovalTransitionResult> {
  return transitionPendingApprovalExecution(file, id, claimToken, "claimed", "denied", detail, now);
}

export async function finalizePendingApprovalExecution(
  file: string,
  id: string,
  claimToken: string,
  state: "succeeded" | "unknown",
  detail?: string,
  now: () => Date = () => new Date()
): Promise<PendingApprovalTransitionResult> {
  return transitionPendingApprovalExecution(file, id, claimToken, "executing", state, detail, now);
}

export async function readPendingApprovals(file: string): Promise<readonly PendingApproval[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { pending?: unknown }).pending)) {
    return [];
  }
  return (parsed as { pending: unknown[] }).pending.filter(isPendingApproval);
}

// Per-file mutation queue: record/clear are read-modify-write, so two
// concurrent calls would otherwise both read the same `existing` and the second
// write would clobber the first (last-writer-wins, a silently dropped pending
// approval — i.e. a refused action lost). Serialising the WHOLE op per file
// makes the store lossless under concurrency, mirroring the inbox write-queue.
function serializePerFile<T>(file: string, op: () => Promise<T>): Promise<T> {
  return withMessagingFileMutation(file, op);
}

/**
 * Append a pending approval, capped to the most recent
 * `PENDING_APPROVAL_MAX_ENTRIES` so a chatty refused channel can't grow
 * the file without bound. Serialised per file (lossless under concurrency).
 */
export async function recordPendingApproval(file: string, entry: PendingApproval): Promise<void> {
  await serializePerFile(file, async () => {
    if (!isExactNewPendingApproval(entry)) {
      throw new Error("invalid pending approval entry");
    }
    const store = await readMutationStore(file) ?? { executions: [], pending: [], version: 2 as const };
    if (store.executions.some((execution) => execution.approvalSnapshot.id === entry.id)
      || store.pending.some((pending) => pending.id === entry.id)) {
      throw new Error(`approval id has already been used: ${entry.id}`);
    }
    const combined = [...store.pending, entry];
    const capped = combined.length > PENDING_APPROVAL_MAX_ENTRIES
      ? combined.slice(combined.length - PENDING_APPROVAL_MAX_ENTRIES)
      : combined;
    await writePendingApprovalStore(file, { ...store, pending: capped });
  });
}

/**
 * The live worklist: un-expired pending approvals, newest first,
 * optionally scoped to one channel. Expired entries are filtered out for
 * display but are never rewritten as a side effect of a read or no-op.
 */
export function filterUnexpired(
  pending: readonly PendingApproval[],
  now: Date,
  scope?: { readonly providerId: string; readonly source: string }
): readonly PendingApproval[] {
  const cutoff = now.getTime();
  return pending
    .filter((entry) => Date.parse(entry.expiresAt) > cutoff)
    .filter((entry) => !scope || (entry.providerId === scope.providerId && entry.source === scope.source))
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listPendingApprovals(
  file: string,
  now: () => Date = () => new Date(),
  scope?: { readonly providerId: string; readonly source: string }
): Promise<readonly PendingApproval[]> {
  return filterUnexpired(await readPendingApprovals(file), now(), scope);
}

/**
 * Durably dismiss a pending approval by id. Returns true only when the
 * pending entry became a denied tombstone; no-op calls preserve bytes.
 */
export async function clearPendingApproval(file: string, id: string, now: () => Date = () => new Date()): Promise<boolean> {
  return (await denyPendingApproval(file, id, { surface: "cli" }, "dismissed", now)).transitioned;
}
