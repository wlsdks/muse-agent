/**
 * Pure data layer for the reviewable autonomous-action log
 * (`~/.muse/action-log.json`).
 *
 * Accountability (P6-b1): every autonomous action Muse takes —
 * whether it performed or was refused — records a rationale-bearing
 * entry the user can review later (what / why / when / result).
 * Trust requires the user can SEE what was done on their behalf.
 *
 * APPEND-ONLY by contract: an audit log must never lose or rewrite
 * history, so there is no upsert/patch — only `appendActionLog`.
 * Same durability posture as the other personal stores: atomic
 * fsync+rename write, tolerant read, corrupt store quarantined
 * aside (never destroyed).
 *
 * TAMPER-EVIDENT (not tamper-proof): each entry stores `prevHash`, the
 * SHA-256 of the entry before it bound to that entry's own content, so a
 * deletion, reorder, or in-place edit of any historical entry deterministically
 * breaks the chain at a precise index — surfaced by `verifyActionLogChain` /
 * `muse actions --verify` (Merkle hash-chain: Haber-Stornetta 1991; RFC 6962).
 * This detects partial-write / accidental / external-process mutation, NOT a
 * motivated attacker who recomputes the whole chain after editing (that needs an
 * off-box anchor, out of scope). The chain is append-local: the most recent entry
 * is sealed by the NEXT append.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import type { JsonObject } from "@muse/shared";

import { decryptFileAtRest, encryptFileAtRest, isFileEncryptedAtRest, readMaybeEncrypted, withFileLock, writeMaybeEncrypted } from "./encrypted-file.js";

export type ActionResult = "performed" | "refused" | "failed";

export interface ActionLogEntry {
  readonly id: string;
  /** User the action was taken on behalf of (~/.muse bucket). */
  readonly userId: string;
  /** ISO timestamp the action was attempted. */
  readonly when: string;
  /** WHAT was done — a concise human description of the action. */
  readonly what: string;
  /** WHY — the rationale (the objective spec / trigger reason). */
  readonly why: string;
  /** Outcome. `refused` covers a fail-closed consent block. */
  readonly result: ActionResult;
  /** Standing objective that triggered the action, when applicable. */
  readonly objectiveId?: string;
  /** Free-form result detail ("HTTP 201", "no recorded consent"). */
  readonly detail?: string;
  /**
   * Tamper-evidence link: SHA-256 of the previous entry (its content + ITS
   * prevHash). Set by `appendActionLog`; absent on legacy pre-chain entries,
   * which verify as a valid prefix. Excluded from this entry's own hashed body.
   */
  readonly prevHash?: string;
}

/** The fixed root the first chained entry's `prevHash` points at. */
export const ACTION_LOG_GENESIS_HASH = `genesis:${createHash("sha256").update("muse-action-log/v1").digest("hex")}`;

/** The hashed BODY of an entry — content fields only, `prevHash` excluded (a chain link can't hash itself). Stable key order ⇒ stable hash. */
function canonicalActionContent(entry: ActionLogEntry): JsonObject {
  return {
    id: entry.id,
    result: entry.result,
    userId: entry.userId,
    what: entry.what,
    when: entry.when,
    why: entry.why,
    ...(entry.objectiveId ? { objectiveId: entry.objectiveId } : {}),
    ...(entry.detail ? { detail: entry.detail } : {})
  };
}

/**
 * SHA-256 of an entry: its canonical content bound to `prevHash`. A single
 * flipped byte in the content OR a different predecessor diverges this hash —
 * which is the NEXT entry's `prevHash`, so the divergence cascades to the tip.
 */
export function computeEntryHash(entry: ActionLogEntry, prevHash: string): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalActionContent(entry)))
    .update("\n")
    .update(prevHash)
    .digest("hex");
}

/** Hash of the chain's current tip — what the NEXT appended entry's `prevHash` becomes. */
function chainTipHash(entries: readonly ActionLogEntry[]): string {
  if (entries.length === 0) {
    return ACTION_LOG_GENESIS_HASH;
  }
  const last = entries[entries.length - 1]!;
  return computeEntryHash(last, last.prevHash ?? ACTION_LOG_GENESIS_HASH);
}

export interface ActionLogChainVerification {
  readonly ok: boolean;
  /** Index (in stored/append order) where the chain first breaks, or null when intact. */
  readonly brokenAtIndex: number | null;
  readonly reason: string;
  /** Number of hash-linked entries verified (legacy prefix excluded). */
  readonly linkedEntries: number;
}

/**
 * Walk the log in STORED (append) order and recompute every hash link. Legacy
 * entries lacking `prevHash` are a valid pre-chain PREFIX (older logs predate the
 * chain) — verification starts at the first hash-bearing entry; once the chain
 * has begun, a missing link is itself a break (an entry was deleted/inserted).
 * Pure (takes the array) so it is unit-testable without fs.
 */
export function verifyActionLogChain(entries: readonly ActionLogEntry[]): ActionLogChainVerification {
  const firstChained = entries.findIndex((e) => e.prevHash !== undefined);
  if (firstChained === -1) {
    return {
      brokenAtIndex: null,
      linkedEntries: 0,
      ok: true,
      reason: `no hash-chain present — ${entries.length.toString()} legacy entr${entries.length === 1 ? "y" : "ies"} (chain seals on the next append)`
    };
  }
  let linked = 0;
  for (let i = firstChained; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.prevHash === undefined) {
      return {
        brokenAtIndex: i,
        linkedEntries: linked,
        ok: false,
        reason: `entry ${i.toString()} has no chain link after the chain began — an entry was deleted or inserted`
      };
    }
    const expected = i === 0
      ? ACTION_LOG_GENESIS_HASH
      : computeEntryHash(entries[i - 1]!, entries[i - 1]!.prevHash ?? ACTION_LOG_GENESIS_HASH);
    if (entry.prevHash !== expected) {
      return {
        brokenAtIndex: i,
        linkedEntries: linked,
        ok: false,
        reason: `entry ${i.toString()} (${entry.id}) does not chain to entry ${(i - 1).toString()} — content was altered, reordered, or an entry was deleted/inserted`
      };
    }
    linked += 1;
  }
  return {
    brokenAtIndex: null,
    linkedEntries: linked,
    ok: true,
    reason: `chain intact — ${linked.toString()} linked entr${linked === 1 ? "y" : "ies"} verified`
  };
}

async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}

export async function readActionLog(file: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly ActionLogEntry[]> {
  // A WRONG key THROWS here (fail-closed) — propagate it; an undecryptable log is
  // NOT corrupt and must NEVER be quarantined-to-empty (that would erase the
  // user's confided action history on a key mismatch).
  const { text } = await readMaybeEncrypted(file, env);
  if (text === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { entries: unknown[] }).entries.flatMap((entry): readonly ActionLogEntry[] =>
    isActionLogEntry(entry) ? [entry] : []
  );
}

async function writeActionLog(file: string, entries: readonly ActionLogEntry[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const text = `${JSON.stringify({ entries }, null, 2)}\n`;
  // Peek + write under the SAME cross-process lock the migration uses so an
  // ordinary append can't race `encryptActionLogAtRest` and clobber it with a
  // stale-format payload; format is preserved (encrypted stays encrypted,
  // plaintext stays plaintext). atomicWriteFile keeps the 0o600 owner-only mode.
  await withFileLock(file, async () => {
    const encrypted = await isFileEncryptedAtRest(file);
    await writeMaybeEncrypted(file, text, encrypted, env);
  });
}

/**
 * Append one entry. Append-only: existing entries are preserved
 * verbatim and the new one is added at the end (chronological).
 * A duplicate `id` is still appended — the log records attempts,
 * it does not deduplicate them.
 */
// Per-file queue: the audit log is the accountability trail, so a concurrent
// append (multi-channel actions / daemons) must NOT lose an entry to a
// last-writer-wins read-modify-write. Serialise the whole append per file.
const appendQueues = new Map<string, Promise<unknown>>();

export async function appendActionLog(file: string, entry: ActionLogEntry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const prior = appendQueues.get(file) ?? Promise.resolve();
  const op = async (): Promise<void> => {
    const existing = await readActionLog(file, env);
    // Seal the new entry to the chain tip — its prevHash binds it to all prior
    // history, so a later deletion/edit/reorder breaks verification at a precise
    // index. The append queue already serialises the read-modify-write, so two
    // concurrent appends can't fork the chain.
    const chained: ActionLogEntry = { ...entry, prevHash: chainTipHash(existing) };
    await writeActionLog(file, [...existing, chained], env);
  };
  const next = prior.then(op, op);
  appendQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Verify the on-disk action log's hash-chain. Reads in STORED (append) order —
 * NOT `queryActionLog`, which re-sorts newest-first and would falsely report a
 * break. A missing file is a vacuously-intact empty chain.
 */
export async function verifyActionLogChainFile(file: string, env: NodeJS.ProcessEnv = process.env): Promise<ActionLogChainVerification> {
  return verifyActionLogChain(await readActionLog(file, env));
}

/**
 * Review surface: the entries the user can see, newest first,
 * optionally scoped to one user. This is what `muse actions` /
 * an `/api/actions` route render.
 */
export async function queryActionLog(
  file: string,
  query: { readonly userId?: string } = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<readonly ActionLogEntry[]> {
  const all = await readActionLog(file, env);
  const scoped = query.userId ? all.filter((e) => e.userId === query.userId) : all;
  return [...scoped].sort((a, b) => {
    // Compare parsed instants, not raw ISO strings: lexicographic
    // order is wrong across mixed precision ("…00.500Z" sorts
    // before "…01Z") and timezone offsets, which would mis-order
    // this newest-first accountability surface. Unparseable values
    // keep a deterministic string order.
    const aMs = Date.parse(a.when);
    const bMs = Date.parse(b.when);
    if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
      if (aMs !== bMs) {
        return bMs - aMs;
      }
    } else if (a.when !== b.when) {
      return b.when.localeCompare(a.when);
    }
    return b.id.localeCompare(a.id);
  });
}

export function serializeActionLogEntry(entry: ActionLogEntry): JsonObject {
  return {
    ...canonicalActionContent(entry),
    ...(entry.prevHash ? { prevHash: entry.prevHash } : {})
  };
}

function isActionLogEntry(value: unknown): value is ActionLogEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const e = value as ActionLogEntry;
  if (
    typeof e.id !== "string" ||
    typeof e.userId !== "string" ||
    typeof e.when !== "string" ||
    typeof e.what !== "string" ||
    typeof e.why !== "string"
  ) {
    return false;
  }
  if (e.prevHash !== undefined && typeof e.prevHash !== "string") {
    return false;
  }
  return e.result === "performed" || e.result === "refused" || e.result === "failed";
}

/**
 * Canonical empty action-log body — seeded when encrypting an absent/empty store
 * so the encrypted format is ESTABLISHED on disk (otherwise the first later
 * append would peek "no file", land in plaintext, and silently drop the encrypt
 * intent).
 */
const EMPTY_ACTION_LOG_BODY = `${JSON.stringify({ entries: [] }, null, 2)}\n`;

/**
 * One-shot migrate the action log to encryption-at-rest (AES-256-GCM under the
 * shared MUSE_MEMORY_KEY / per-host fallback, the same envelope episodes + memory
 * use). Snapshots a plaintext backup BEFORE encrypting, runs under the
 * cross-process lock, and is idempotent. The tamper-evident hash chain is
 * unaffected — it lives in the plaintext entries, decrypted before verification.
 */
export async function encryptActionLogAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly alreadyEncrypted: boolean; readonly backupPath?: string }> {
  return encryptFileAtRest(file, env, { emptyContent: EMPTY_ACTION_LOG_BODY });
}

/** Reverse the migration — rewrite the action log as plaintext. Throws fail-closed on a wrong key. */
export async function decryptActionLogAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly alreadyPlaintext: boolean }> {
  return decryptFileAtRest(file, env);
}

/** Format-only check (no key needed) — is the action log encrypted at rest? */
export async function isActionLogEncrypted(file: string): Promise<boolean> {
  return isFileEncryptedAtRest(file);
}
