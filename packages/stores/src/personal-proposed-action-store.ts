/**
 * Proposed-action store — the draft-first bridge between an autonomous
 * trigger (a daemon tick / standing objective noticing something) and a
 * state-changing action. Muse PROPOSES the exact action and persists it
 * here as `pending`; nothing leaves until the user explicitly confirms
 * it (`muse propose approve <id>`), at which point it executes ONCE and
 * flips to `executed`. Decline → `declined` (+ a veto so the class
 * stops re-proposing). This is `outbound-safety.md` as code: the agent
 * never sends on its own judgement.
 *
 * Same durability posture as the sibling personal stores: atomic write
 * (tmp + fsync + rename), tolerant read, corrupt store quarantined.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { inspectReadOnlyJsonSource, type ReadOnlySourceInspection } from "@muse/shared";
import { withFileLock } from "./encrypted-file.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export type ProposedActionStatus = "pending" | "executed" | "declined";

/** Only `message` today; the kind tags how `confirm` executes the draft. */
export type ProposedActionKind = "message";

export interface ProposedAction {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly kind: ProposedActionKind;
  /** One-line human description shown in `muse propose list`. */
  readonly summary: string;
  /** WHY this was proposed (the trigger) — carried into the action log. */
  readonly reason: string;
  /** Provider-neutral route and exact recipient shown to the owner. */
  readonly channel: string;
  readonly recipient: string;
  /** The exact message draft (kind === "message"). */
  readonly text: string;
  /** Binds channel + recipient + exact text + expiry to the explicit approval step. */
  readonly payloadHash: string;
  readonly status: ProposedActionStatus;
  /**
   * ISO timestamp after which the proposal may no longer be confirmed
   * — outbound-safety's "approval times out → the action does not
   * happen". Missing expiry is invalid and therefore never actionable.
   */
  readonly expiresAt: string;
  /** ISO timestamp the proposal was executed / declined. */
  readonly resolvedAt?: string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const SHA256_RE = /^[0-9a-f]{64}$/u;

export function computeProposedActionPayloadHash(
  channel: string,
  recipient: string,
  text: string,
  expiresAt: string
): string {
  return createHash("sha256")
    .update(JSON.stringify({ channel, expiresAt, recipient, text }), "utf8")
    .digest("hex");
}

/**
 * A proposal is actionable only while it is still `pending` AND not yet
 * past its `expiresAt`. An expired proposal is inert — it can neither
 * be listed as awaiting confirmation nor executed.
 */
export function isProposalActionable(proposal: ProposedAction, now: Date): boolean {
  if (proposal.status !== "pending") return false;
  const expiry = Date.parse(proposal.expiresAt);
  return Number.isFinite(now.getTime())
    && Number.isFinite(expiry)
    && now.getTime() <= expiry
    && proposal.payloadHash === computeProposedActionPayloadHash(
      proposal.channel,
      proposal.recipient,
      proposal.text,
      proposal.expiresAt
    );
}

function resolveProposalTtlMs(value: number | undefined, nowMs: number): number {
  const latestValidTtlMs = Math.max(0, MAX_DATE_MS - nowMs);
  const ttlMs = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_TTL_MS;
  if (ttlMs > latestValidTtlMs) {
    return Math.min(DEFAULT_TTL_MS, latestValidTtlMs);
  }
  return ttlMs;
}

function isProposedAction(value: unknown): value is ProposedAction {
  if (!value || typeof value !== "object") return false;
  const c = value as ProposedAction;
  return typeof c.id === "string"
    && typeof c.userId === "string"
    && typeof c.createdAt === "string"
    && c.kind === "message"
    && typeof c.summary === "string"
    && typeof c.reason === "string"
    && typeof c.channel === "string"
    && c.channel.trim().length > 0
    && c.channel === c.channel.trim()
    && typeof c.recipient === "string"
    && c.recipient.trim().length > 0
    && c.recipient === c.recipient.trim()
    && typeof c.text === "string"
    && c.text.trim().length > 0
    && typeof c.payloadHash === "string"
    && SHA256_RE.test(c.payloadHash)
    && c.payloadHash === computeProposedActionPayloadHash(c.channel, c.recipient, c.text, c.expiresAt)
    && (c.status === "pending" || c.status === "executed" || c.status === "declined")
    && typeof c.expiresAt === "string"
    && Number.isFinite(Date.parse(c.expiresAt))
    && (c.resolvedAt === undefined || (typeof c.resolvedAt === "string" && Number.isFinite(Date.parse(c.resolvedAt))));
}

function normalizeProposedAction(value: unknown): ProposedAction | undefined {
  if (isProposedAction(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const legacy = value as Record<string, unknown>;
  if (typeof legacy.providerId !== "string"
    || typeof legacy.destination !== "string"
    || typeof legacy.expiresAt !== "string") {
    return undefined;
  }
  const normalized: Record<string, unknown> = {
    ...legacy,
    channel: legacy.providerId,
    payloadHash: typeof legacy.text === "string"
      ? computeProposedActionPayloadHash(legacy.providerId, legacy.destination, legacy.text, legacy.expiresAt)
      : "",
    recipient: legacy.destination
  };
  delete normalized.providerId;
  delete normalized.destination;
  return isProposedAction(normalized) ? normalized : undefined;
}

export interface ProposedActionSourceSnapshot {
  readonly proposals: readonly ProposedAction[];
  readonly excludedCount: number;
}

/** Status-only inspection that preserves corrupt/absent states and never invokes quarantine writes. */
export function inspectProposedActionsSource(file: string): Promise<ReadOnlySourceInspection<ProposedActionSourceSnapshot>> {
  return inspectReadOnlyJsonSource(file, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "proposals") || !Array.isArray(record.proposals)) return undefined;
    const proposals = record.proposals.flatMap((entry) => {
      const proposal = normalizeProposedAction(entry);
      return proposal ? [proposal] : [];
    });
    return { excludedCount: record.proposals.length - proposals.length, proposals };
  });
}

export async function readProposedActions(file: string): Promise<ProposedAction[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { proposals?: unknown }).proposals)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { proposals: unknown[] }).proposals.flatMap((entry) => {
    const proposal = normalizeProposedAction(entry);
    return proposal ? [proposal] : [];
  });
}

export async function writeProposedActions(file: string, proposals: readonly ProposedAction[]): Promise<void> {
  if (!proposals.every(isProposedAction)) {
    throw new Error("proposed action store contains an invalid draft");
  }
  const payload = `${JSON.stringify({ proposals }, null, 2)}\n`;
  // random-uuid tmp: a `${pid}-${Date.now()}` name collides between two same-ms
  // concurrent writers → ENOENT rename. The cross-process lock below serialises
  // the read-modify-write callers so a proposed/patched action is never lost.
  const tmp = `${file}.tmp-${process.pid.toString()}-${randomUUID()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/**
 * Persist a proposed message action as `pending`. Does NOT send — the
 * draft sits until the user confirms it.
 */
export async function proposeMessageAction(
  file: string,
  input: {
    readonly userId: string;
    readonly summary: string;
    readonly reason: string;
    readonly providerId: string;
    readonly destination: string;
    readonly text: string;
    readonly ttlMs?: number;
    readonly now?: () => Date;
  }
): Promise<ProposedAction> {
  const now = input.now ?? (() => new Date());
  const at = now();
  if (!Number.isFinite(at.getTime())
    || input.providerId.trim().length === 0
    || input.providerId !== input.providerId.trim()
    || input.destination.trim().length === 0
    || input.destination !== input.destination.trim()
    || input.text.trim().length === 0) {
    throw new Error("proposed message action requires a valid time, channel, recipient, and payload");
  }
  const createdAt = at.toISOString();
  const ttlMs = resolveProposalTtlMs(input.ttlMs, at.getTime());
  const channel = input.providerId;
  const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
  const recipient = input.destination;
  const proposal: ProposedAction = {
    channel,
    createdAt,
    expiresAt,
    id: `prop_${randomUUID()}`,
    kind: "message",
    payloadHash: computeProposedActionPayloadHash(channel, recipient, input.text, expiresAt),
    reason: input.reason,
    recipient,
    status: "pending",
    summary: input.summary,
    text: input.text,
    userId: input.userId
  };
  // Serialised read-modify-write under a CROSS-PROCESS file lock (mirrors
  // personal-tasks-store's mutateTasks): this store IS outbound-safety.md as
  // code — the draft-first approval gate itself — so a daemon tick proposing
  // an action and a CLI `propose`/`approve` (separate processes) racing must
  // not silently drop a pending draft or an approve/decline resolution. The
  // former in-process-only queue did not stop that cross-process race.
  await withFileLock(file, async () => {
    const existing = await readProposedActions(file);
    await writeProposedActions(file, [...existing, proposal]);
  });
  return proposal;
}

export async function patchProposedActionStatus(
  file: string,
  id: string,
  status: ProposedActionStatus,
  resolvedAt: string
): Promise<void> {
  await withFileLock(file, async () => {
    const all = await readProposedActions(file);
    await writeProposedActions(
      file,
      all.map((p) => (p.id === id ? { ...p, resolvedAt, status } : p))
    );
  });
}
