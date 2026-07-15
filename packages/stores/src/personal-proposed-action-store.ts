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

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

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
  /** The exact message draft (kind === "message"). */
  readonly providerId: string;
  readonly destination: string;
  readonly text: string;
  readonly status: ProposedActionStatus;
  /**
   * ISO timestamp after which the proposal may no longer be confirmed
   * — outbound-safety's "approval times out → the action does not
   * happen". Absent = no expiry (back-compatible with older entries).
   */
  readonly expiresAt?: string;
  /** ISO timestamp the proposal was executed / declined. */
  readonly resolvedAt?: string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A proposal is actionable only while it is still `pending` AND not yet
 * past its `expiresAt`. An expired proposal is inert — it can neither
 * be listed as awaiting confirmation nor executed.
 */
export function isProposalActionable(proposal: ProposedAction, now: Date): boolean {
  if (proposal.status !== "pending") return false;
  if (proposal.expiresAt === undefined) return true;
  const expiry = Date.parse(proposal.expiresAt);
  return Number.isNaN(expiry) || now.getTime() <= expiry;
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
    && typeof c.providerId === "string"
    && typeof c.destination === "string"
    && typeof c.text === "string"
    && (c.status === "pending" || c.status === "executed" || c.status === "declined");
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
  return (parsed as { proposals: unknown[] }).proposals.flatMap((entry) =>
    isProposedAction(entry) ? [entry] : []
  );
}

export async function writeProposedActions(file: string, proposals: readonly ProposedAction[]): Promise<void> {
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
  const createdAt = at.toISOString();
  const ttlMs = typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs) && input.ttlMs > 0
    ? input.ttlMs
    : DEFAULT_TTL_MS;
  const proposal: ProposedAction = {
    createdAt,
    destination: input.destination,
    expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
    id: `prop_${Date.parse(createdAt).toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "message",
    providerId: input.providerId,
    reason: input.reason,
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
