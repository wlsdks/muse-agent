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
 * tolerant read, atomic write, corrupt file quarantined aside.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

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
  );
}

async function quarantineCorrupt(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // best-effort; the read still degrades to empty
  }
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
    await quarantineCorrupt(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { pending?: unknown }).pending)) {
    await quarantineCorrupt(file);
    return [];
  }
  return (parsed as { pending: unknown[] }).pending.filter(isPendingApproval);
}

async function writePendingApprovals(file: string, pending: readonly PendingApproval[]): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  // The tmp name MUST be unique per in-flight write: two concurrent writes in
  // the same millisecond+pid would otherwise pick the same tmp path, and one
  // rename consumes the other's tmp → ENOENT. A random uuid guarantees
  // uniqueness (there is no write-queue serialising callers here).
  const tmp = `${file}.tmp-${process.pid.toString()}-${randomUUID()}`;
  const payload = `${JSON.stringify({ pending }, null, 2)}\n`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

// Per-file mutation queue: record/clear are read-modify-write, so two
// concurrent calls would otherwise both read the same `existing` and the second
// write would clobber the first (last-writer-wins, a silently dropped pending
// approval — i.e. a refused action lost). Serialising the WHOLE op per file
// makes the store lossless under concurrency, mirroring the inbox write-queue.
const mutationQueues = new Map<string, Promise<unknown>>();
function serializePerFile<T>(file: string, op: () => Promise<T>): Promise<T> {
  const prior = mutationQueues.get(file) ?? Promise.resolve();
  const next = prior.then(op, op);
  mutationQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Append a pending approval, capped to the most recent
 * `PENDING_APPROVAL_MAX_ENTRIES` so a chatty refused channel can't grow
 * the file without bound. Serialised per file (lossless under concurrency).
 */
export async function recordPendingApproval(file: string, entry: PendingApproval): Promise<void> {
  await serializePerFile(file, async () => {
    const existing = await readPendingApprovals(file);
    const combined = [...existing, entry];
    const capped = combined.length > PENDING_APPROVAL_MAX_ENTRIES
      ? combined.slice(combined.length - PENDING_APPROVAL_MAX_ENTRIES)
      : combined;
    await writePendingApprovals(file, capped);
  });
}

/**
 * The live worklist: un-expired pending approvals, newest first,
 * optionally scoped to one channel. Expired entries are filtered out
 * (and are pruned from disk on the next `clear`/`record`).
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
 * Remove a pending approval by id (e.g. once it's been actioned or
 * dismissed). Returns true when an entry was removed. Also drops any
 * expired entries while rewriting, keeping the file lean.
 */
export async function clearPendingApproval(file: string, id: string, now: () => Date = () => new Date()): Promise<boolean> {
  return serializePerFile(file, async () => {
    const existing = await readPendingApprovals(file);
    const cutoff = now().getTime();
    const kept = existing.filter((entry) => entry.id !== id && Date.parse(entry.expiresAt) > cutoff);
    if (kept.length === existing.length) {
      return false;
    }
    await writePendingApprovals(file, kept);
    return true;
  });
}
