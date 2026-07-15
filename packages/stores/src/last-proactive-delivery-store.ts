/**
 * A small sidecar recording the most recent notices the interruption-gate
 * actually reached the user with — delivered OR queued to the digest, one
 * entry per gate outcome. This is what the channel-veto reply handler
 * ("stop"/"그만") consults to resolve "what did Muse just send me": the
 * `sourceKey` recorded here is the exact avoidance unit the trust ledger's
 * `avoidedSourceKeys` checks against later, so the two stores stay in lockstep
 * by construction — never a guessed id.
 *
 * Bounded to the newest `MAX_ENTRIES` (append order, oldest-first, trimmed on
 * write) — this is a lookup sidecar for "what just happened", not an audit
 * log, so unlike `proactive-trust-ledger` it has no reason to grow unbounded.
 * Atomic tmp+rename (0o600), tolerant reads (missing/corrupt → empty),
 * mutation-queued appends — mirrors `digest-queue.ts`.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

export type LastProactiveDeliveryOutcome = "delivered" | "digested";

export interface LastProactiveDeliveryEntry {
  /** ISO timestamp of the delivery/digest event. */
  readonly at: string;
  /** The avoidance unit, `${kind}:${id}` — ledger-compatible with `proactive-trust-ledger`'s `sourceKey`. */
  readonly sourceKey: string;
  readonly outcome: LastProactiveDeliveryOutcome;
  /** Human label for a veto confirmation message, when the loop has one. */
  readonly title?: string;
}

const MAX_ENTRIES = 20;

function isLastProactiveDeliveryEntry(value: unknown): value is LastProactiveDeliveryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.at === "string"
    && !Number.isNaN(new Date(entry.at).getTime())
    && typeof entry.sourceKey === "string"
    && (entry.outcome === "delivered" || entry.outcome === "digested")
    && (entry.title === undefined || typeof entry.title === "string")
  );
}

export async function readLastProactiveDeliveries(file: string): Promise<readonly LastProactiveDeliveryEntry[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { deliveries?: unknown }).deliveries)) {
    return [];
  }
  return (parsed as { deliveries: unknown[] }).deliveries.flatMap((entry): readonly LastProactiveDeliveryEntry[] =>
    isLastProactiveDeliveryEntry(entry) ? [entry] : []
  );
}

async function writeLastProactiveDeliveries(file: string, entries: readonly LastProactiveDeliveryEntry[]): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify({ deliveries: entries }, null, 2)}\n`);
}

/**
 * Append one delivered/digested record, trimming to the newest
 * `MAX_ENTRIES`. Serialised on the shared per-file mutation queue so
 * concurrent appends (overlapping daemon ticks) can't clobber each other.
 */
export async function appendLastProactiveDelivery(
  file: string,
  entry: {
    readonly at: Date;
    readonly sourceKey: string;
    readonly outcome: LastProactiveDeliveryOutcome;
    readonly title?: string;
  }
): Promise<void> {
  await withFileMutationQueue(file, async () => {
    const existing = await readLastProactiveDeliveries(file);
    const next: LastProactiveDeliveryEntry = {
      at: entry.at.toISOString(),
      outcome: entry.outcome,
      sourceKey: entry.sourceKey,
      ...(entry.title !== undefined ? { title: entry.title } : {})
    };
    const combined = [...existing, next];
    const trimmed = combined.length > MAX_ENTRIES ? combined.slice(combined.length - MAX_ENTRIES) : combined;
    await writeLastProactiveDeliveries(file, trimmed);
  });
}
