/**
 * Pure data layer for rejected Builder automation proposals
 * (`~/.muse/automation-rejected-proposals.json`).
 *
 * A proposal the user dismissed ("사양할게요") must never resurface — this
 * is the durable memory of that. Same durability posture as the other
 * personal stores: atomic fsync+rename write, tolerant read, corrupt store
 * quarantined aside (never destroyed), cross-process file lock on the
 * read-modify-write so a concurrent CLI + server reject never race-clobber
 * each other.
 */

import { promises as fs } from "node:fs";

import type { JsonObject } from "@muse/shared";

import { atomicWriteFile, withFileLock } from "./atomic-file-store.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export interface RejectedProposal {
  readonly id: string;
  readonly rejectedAt: string;
}

export async function readRejectedProposals(file: string): Promise<readonly RejectedProposal[]> {
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
    await quarantineCorruptStore(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { rejected?: unknown }).rejected)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { rejected: unknown[] }).rejected.flatMap((entry): readonly RejectedProposal[] =>
    isRejectedProposal(entry) ? [entry] : []
  );
}

export async function writeRejectedProposals(file: string, entries: readonly RejectedProposal[]): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify({ rejected: entries }, null, 2)}\n`);
}

/**
 * Record a rejection. Idempotent on `id`: rejecting the same proposal id
 * twice REPLACES the timestamp rather than duplicating the entry — the
 * evidence-gate caller only needs the SET of rejected ids, never a count.
 */
export async function recordRejectedProposal(file: string, id: string, rejectedAt: string): Promise<void> {
  await withFileLock(file, async () => {
    const existing = await readRejectedProposals(file);
    const filtered = existing.filter((entry) => entry.id !== id);
    await writeRejectedProposals(file, [...filtered, { id, rejectedAt }]);
  });
}

/** Just the ids — what `proposeFlowsFromPatterns`'s `rejectedIds` parameter wants. */
export function rejectedProposalIds(entries: readonly RejectedProposal[]): readonly string[] {
  return entries.map((entry) => entry.id);
}

export function serializeRejectedProposal(entry: RejectedProposal): JsonObject {
  return { id: entry.id, rejectedAt: entry.rejectedAt };
}

function isRejectedProposal(value: unknown): value is RejectedProposal {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as RejectedProposal;
  return typeof v.id === "string" && typeof v.rejectedAt === "string";
}
