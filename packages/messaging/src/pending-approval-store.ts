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

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { inspectReadOnlyJsonSource, type ReadOnlySourceInspection } from "@muse/shared";
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
  /** Present only for a third-party-bound effect; local approvals omit it. */
  readonly thirdPartySend?: ThirdPartySendDraftBinding;
}

export interface ThirdPartySendDraftBinding {
  readonly channel: string;
  readonly recipient: string;
  /** SHA-256 of tool + channel + recipient + exact draft/arguments + expiry. */
  readonly payloadHash: string;
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

export type PendingApprovalActor =
  | { readonly surface: "api"; readonly requestUserId?: string }
  | { readonly surface: "cli" };

export type PendingApprovalObservedState = "pending" | PendingApprovalExecutionState | "not-found" | "expired";

export const CLAIM_RECOVERY_LEASE_MS = 15 * 60 * 1000;

const RECOVERABLE_PENDING_APPROVAL_TOOLS = new Set(["muse.tasks.add", "muse.tasks.complete"]);
const PENDING_APPROVAL_STATUS_DRAFT_MAX_LENGTH = 240;
const SHA256_RE = /^[0-9a-f]{64}$/u;

export function computePendingApprovalPayloadHash(input: {
  readonly arguments: Record<string, unknown>;
  readonly channel: string;
  readonly draft: string;
  readonly expiresAt: string;
  readonly recipient: string;
  readonly tool: string;
}): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

export function createThirdPartySendDraftBinding(input: {
  readonly arguments: Record<string, unknown>;
  readonly channel: string;
  readonly draft: string;
  readonly expiresAt: string;
  readonly recipient: string;
  readonly tool: string;
}): ThirdPartySendDraftBinding {
  if (input.channel.trim().length === 0
    || input.channel !== input.channel.trim()
    || input.recipient.trim().length === 0
    || input.recipient !== input.recipient.trim()
    || input.tool.trim().length === 0
    || input.tool !== input.tool.trim()
    || input.draft.trim().length === 0
    || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("third-party send draft requires an exact channel, recipient, and expiry");
  }
  return {
    channel: input.channel,
    payloadHash: computePendingApprovalPayloadHash(input),
    recipient: input.recipient
  };
}

export interface PendingApprovalStatus {
  readonly id: string;
  readonly tool: string;
  readonly risk: PendingApproval["risk"];
  readonly state: "pending" | PendingApprovalExecutionState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly claimedAt?: string;
  readonly updatedAt?: string;
  readonly recoverable: boolean;
  readonly recoverableAt?: string;
  readonly effectMayHaveOccurred: boolean;
  readonly draft?: string;
  readonly thirdPartySend?: ThirdPartySendDraftBinding;
}

export type PendingApprovalStatusResult =
  | { readonly found: true; readonly status: PendingApprovalStatus }
  | { readonly found: false; readonly state: "not-found" | "expired" | "forbidden" };

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

export type PendingApprovalRecoveryResult =
  | Extract<PendingApprovalClaimResult, { readonly claimedByThisCall: true }>
  | {
      readonly claimedByThisCall: false;
      readonly state: "pending" | PendingApprovalExecutionState | "not-found" | "expired" | "forbidden";
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
    && (e["thirdPartySend"] === undefined || isThirdPartySendDraftBinding(e))
    && (e["userId"] === undefined || typeof e["userId"] === "string")
  );
}

function isThirdPartySendDraftBinding(entry: Record<string, unknown>): boolean {
  const value = entry["thirdPartySend"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (Object.keys(binding).sort().join("\0") !== ["channel", "payloadHash", "recipient"].sort().join("\0")
    || typeof binding["channel"] !== "string"
    || binding["channel"].trim().length === 0
    || binding["channel"] !== binding["channel"].trim()
    || typeof binding["recipient"] !== "string"
    || binding["recipient"].trim().length === 0
    || binding["recipient"] !== binding["recipient"].trim()
    || typeof binding["payloadHash"] !== "string"
    || !SHA256_RE.test(binding["payloadHash"])
    || typeof entry["tool"] !== "string"
    || entry["tool"].trim().length === 0
    || entry["tool"] !== entry["tool"].trim()
    || typeof entry["draft"] !== "string"
    || entry["draft"].trim().length === 0
    || typeof entry["expiresAt"] !== "string"
    || !entry["arguments"]
    || typeof entry["arguments"] !== "object"
    || Array.isArray(entry["arguments"])) {
    return false;
  }
  try {
    return binding["payloadHash"] === computePendingApprovalPayloadHash({
      arguments: entry["arguments"] as Record<string, unknown>,
      channel: binding["channel"],
      draft: entry["draft"],
      expiresAt: entry["expiresAt"],
      recipient: binding["recipient"],
      tool: entry["tool"]
    });
  } catch {
    return false;
  }
}

/** Re-validate a classified send immediately before an approval can execute. */
export function hasExactThirdPartySendDraftBinding(
  entry: PendingApproval,
  route: { readonly channel: string; readonly recipient: string }
): boolean {
  const binding = entry.thirdPartySend;
  if (!binding || binding.channel !== route.channel || binding.recipient !== route.recipient) {
    return false;
  }
  try {
    return binding.payloadHash === computePendingApprovalPayloadHash({
      arguments: entry.arguments,
      channel: route.channel,
      draft: entry.draft,
      expiresAt: entry.expiresAt,
      recipient: route.recipient,
      tool: entry.tool
    });
  } catch {
    return false;
  }
}

function isStrictPendingApproval(value: unknown): value is PendingApproval {
  return isPendingApproval(value)
    && Number.isFinite(Date.parse(value.createdAt))
    && Number.isFinite(Date.parse(value.expiresAt));
}

function isExactNewPendingApproval(value: unknown): value is PendingApproval {
  return isStrictPendingApproval(value)
    && Date.parse(value.createdAt) < Date.parse(value.expiresAt)
    && Object.keys(value).every((key) => key === "id" || key === "tool" || key === "risk" || key === "draft" || key === "arguments" || key === "providerId" || key === "source" || key === "userId" || key === "createdAt" || key === "expiresAt" || key === "thirdPartySend");
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

export interface PendingApprovalSourceSnapshot {
  readonly pending: readonly PendingApproval[];
  readonly excludedCount: number;
}

/** Strict, side-effect-free reader for status surfaces; unlike tolerant readers it never quarantines or collapses corruption to []. */
export function inspectPendingApprovalsSource(file: string): Promise<ReadOnlySourceInspection<PendingApprovalSourceSnapshot>> {
  return inspectReadOnlyJsonSource(file, (value) => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (record["version"] === undefined) {
      if (Object.keys(record).some((key) => key !== "pending") || !Array.isArray(record["pending"])) return undefined;
      const pending = record["pending"].filter(isExactNewPendingApproval);
      return { excludedCount: record["pending"].length - pending.length, pending };
    }
    if (!isPendingApprovalStoreV2(record)) return undefined;
    const pending = record["pending"].filter(isExactNewPendingApproval);
    return { excludedCount: record["pending"].length - pending.length, pending };
  });
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

function actorEffectiveUser(actor: PendingApprovalActor, approval: PendingApproval): string {
  return actor.surface === "api"
    ? actor.requestUserId ?? approval.userId ?? `${approval.providerId}:${approval.source}`
    : approval.userId ?? `${approval.providerId}:${approval.source}`;
}

function actorOwnsApproval(
  actor: PendingApprovalActor,
  approval: PendingApproval,
  execution?: PendingApprovalExecution
): boolean {
  if (actor.surface === "cli") {
    return execution === undefined || actorEffectiveUser(actor, approval) === execution.actor.effectiveUser;
  }
  if (execution !== undefined) {
    return actor.requestUserId !== undefined && actor.requestUserId === execution.actor.effectiveUser;
  }
  return approval.userId === undefined || actor.requestUserId === approval.userId;
}

function publicApprovalStatus(
  approval: PendingApproval,
  state: "pending" | PendingApprovalExecutionState,
  instantMs: number,
  execution?: PendingApprovalExecution
): PendingApprovalStatus {
  const effectMayHaveOccurred = state === "executing" || state === "unknown" || state === "succeeded";
  const recoveryTool = RECOVERABLE_PENDING_APPROVAL_TOOLS.has(approval.tool);
  const updatedAtMs = execution === undefined ? undefined : Date.parse(execution.updatedAt);
  const recoverableAtMs = state === "claimed" && recoveryTool && updatedAtMs !== undefined
    ? updatedAtMs + CLAIM_RECOVERY_LEASE_MS
    : undefined;
  return {
    createdAt: approval.createdAt,
    draft: approval.draft.slice(0, PENDING_APPROVAL_STATUS_DRAFT_MAX_LENGTH),
    effectMayHaveOccurred,
    expiresAt: approval.expiresAt,
    id: approval.id,
    recoverable: recoverableAtMs !== undefined && updatedAtMs !== undefined
      && instantMs >= updatedAtMs && instantMs >= recoverableAtMs,
    risk: approval.risk,
    state,
    tool: approval.tool,
    ...(approval.thirdPartySend === undefined ? {} : { thirdPartySend: approval.thirdPartySend }),
    ...(execution === undefined ? {} : { claimedAt: execution.claimedAt, updatedAt: execution.updatedAt }),
    ...(recoverableAtMs === undefined ? {} : { recoverableAt: new Date(recoverableAtMs).toISOString() })
  };
}

/** Read safe approval metadata without exposing execution authority or payload arguments. */
export async function inspectPendingApprovalStatus(
  file: string,
  id: string,
  actor: PendingApprovalActor,
  now: () => Date = () => new Date()
): Promise<PendingApprovalStatusResult> {
  const instantMs = now().getTime();
  const store = await readMutationStore(file);
  if (!store) {
    return { found: false, state: "not-found" };
  }
  const execution = store.executions.find((candidate) => candidate.approvalSnapshot.id === id);
  const approval = execution?.approvalSnapshot ?? store.pending.find((candidate) => candidate.id === id);
  if (!approval) {
    return { found: false, state: "not-found" };
  }
  if (Date.parse(approval.expiresAt) <= instantMs) {
    return { found: false, state: "expired" };
  }
  if (!actorOwnsApproval(actor, approval, execution)) {
    return { found: false, state: "forbidden" };
  }
  return {
    found: true,
    status: publicApprovalStatus(approval, execution?.state ?? "pending", instantMs, execution)
  };
}

/** Atomically acquire execution authority for one pending approval. */
export async function claimPendingApproval(
  file: string,
  id: string,
  actor: PendingApprovalActor,
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
    const effectiveUser = actorEffectiveUser(actor, approval);
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

/** Atomically rotate authority for one explicitly recovered stale pre-effect claim. */
export async function recoverPendingApprovalClaim(
  file: string,
  id: string,
  actor: PendingApprovalActor,
  now: () => Date = () => new Date()
): Promise<PendingApprovalRecoveryResult> {
  return serializePerFile(file, async () => {
    const instant = now();
    const instantMs = instant.getTime();
    const store = await readMutationStore(file);
    if (!store) {
      return { claimedByThisCall: false, state: "not-found" };
    }
    const index = store.executions.findIndex((execution) => execution.approvalSnapshot.id === id);
    if (index < 0) {
      const pending = store.pending.find((approval) => approval.id === id);
      if (pending && Date.parse(pending.expiresAt) <= instantMs) {
        return { claimedByThisCall: false, state: "expired" };
      }
      if (pending && !actorOwnsApproval(actor, pending)) {
        return { claimedByThisCall: false, state: "forbidden" };
      }
      if (pending) {
        return { claimedByThisCall: false, state: "pending" };
      }
      return { claimedByThisCall: false, state: "not-found" };
    }
    const current = store.executions[index]!;
    const approval = current.approvalSnapshot;
    if (Date.parse(approval.expiresAt) <= instantMs) {
      return { claimedByThisCall: false, state: "expired" };
    }
    if (!actorOwnsApproval(actor, approval, current)) {
      return { claimedByThisCall: false, state: "forbidden" };
    }
    const updatedAtMs = Date.parse(current.updatedAt);
    if (current.state !== "claimed"
      || !RECOVERABLE_PENDING_APPROVAL_TOOLS.has(approval.tool)
      || instantMs < updatedAtMs
      || instantMs < updatedAtMs + CLAIM_RECOVERY_LEASE_MS) {
      return { claimedByThisCall: false, state: current.state };
    }
    const claimToken = randomUUID();
    const recovered: PendingApprovalExecution = {
      ...current,
      claimToken,
      updatedAt: instant.toISOString()
    };
    const executions = store.executions.slice();
    executions[index] = recovered;
    await writePendingApprovalStore(file, { ...store, executions });
    return { approvalSnapshot: approval, claimedByThisCall: true, claimToken, state: "claimed" };
  });
}

export async function denyPendingApproval(
  file: string,
  id: string,
  actor: PendingApprovalActor,
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
    const effectiveUser = actorEffectiveUser(actor, approval);
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

/** Strictly observe one approval's durable state without changing the v2 schema. */
export async function observePendingApprovalState(
  file: string,
  id: string,
  now: () => Date = () => new Date()
): Promise<PendingApprovalObservedState> {
  const store = await readMutationStore(file);
  if (!store) {
    return "not-found";
  }
  const execution = store.executions.find((candidate) => candidate.approvalSnapshot.id === id);
  if (execution) {
    return execution.state;
  }
  const pending = store.pending.find((candidate) => candidate.id === id);
  if (!pending) {
    return "not-found";
  }
  return Date.parse(pending.expiresAt) <= now().getTime() ? "expired" : "pending";
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("pending approval payload must contain finite JSON numbers");
      return input;
    }
    if (Array.isArray(input)) {
      if (seen.has(input)) throw new Error("pending approval payload must be acyclic");
      seen.add(input);
      const output = input.map(normalize);
      seen.delete(input);
      return output;
    }
    if (input && typeof input === "object") {
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("pending approval payload must contain plain JSON objects");
      }
      if (seen.has(input)) throw new Error("pending approval payload must be acyclic");
      seen.add(input);
      const output = Object.fromEntries(
        Object.keys(input as Record<string, unknown>).sort().map((key) => [
          key,
          normalize((input as Record<string, unknown>)[key])
        ])
      );
      seen.delete(input);
      return output;
    }
    throw new Error("pending approval payload must be exact JSON");
  };
  return JSON.stringify(normalize(value));
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
