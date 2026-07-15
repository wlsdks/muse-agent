/**
 * The digest queue — where an UNASKED notice lands when it's over budget
 * (`interruption-budget.ts`) instead of being sent immediately. The daily
 * digest flush compiles this queue's items verbatim into one compressed
 * message; no LLM touches the text (invariant: the digest introduces no new
 * fabrication surface — each item already passed its own loop's gate before
 * it was queued).
 *
 * `text` is normalized to a single line on append (collapsed whitespace,
 * trimmed) so a multi-line notice can't break the digest's one-line-per-item
 * rendering. `drainDigestQueue` removes only what the flush actually sent —
 * `upToAt` bounds the removal to entries appended at or before the compile
 * time, so an item that lands WHILE the flush is compiling is never dropped
 * un-delivered.
 *
 * Atomic tmp+rename, 0o600, malformed → empty, matching the sibling sidecar
 * stores.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

export interface DigestQueueItem {
  /** ISO timestamp of the original notice (rendered in the digest line). */
  readonly at: string;
  /** The suppressing loop, e.g. "pattern-firing", "ambient-notice". */
  readonly source: string;
  /** Single-line normalized notice text (verbatim content, whitespace collapsed). */
  readonly text: string;
  /** Optional dedupe/veto reference for the originating notice. */
  readonly sourceId?: string;
}

function normalizeDigestText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isDigestQueueItem(value: unknown): value is DigestQueueItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.at === "string"
    && !Number.isNaN(new Date(item.at).getTime())
    && typeof item.source === "string"
    && typeof item.text === "string"
    && (item.sourceId === undefined || typeof item.sourceId === "string")
  );
}

export async function readDigestQueue(file: string): Promise<readonly DigestQueueItem[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { queued?: unknown }).queued)) {
    return [];
  }
  return (parsed as { queued: unknown[] }).queued.flatMap((item): readonly DigestQueueItem[] =>
    isDigestQueueItem(item) ? [item] : []
  );
}

async function writeDigestQueue(file: string, items: readonly DigestQueueItem[]): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify({ queued: items }, null, 2)}\n`);
}

/**
 * Append one suppressed-notice record with its text single-line normalized.
 * Serialized on the shared per-file mutation queue so a burst of same-tick
 * suppressions (several loops over budget at once) can't clobber each other.
 */
export async function appendDigestItem(
  file: string,
  item: { readonly at: Date; readonly source: string; readonly text: string; readonly sourceId?: string }
): Promise<void> {
  await withFileMutationQueue(file, async () => {
    const existing = await readDigestQueue(file);
    const next: DigestQueueItem = {
      at: item.at.toISOString(),
      source: item.source,
      text: normalizeDigestText(item.text),
      ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {})
    };
    await writeDigestQueue(file, [...existing, next]);
  });
}

/**
 * Remove queued items from the queue. With `upToAt`, removes only items at or
 * before that timestamp (a compile-then-send flush drains exactly what it
 * compiled, never an item appended mid-flush); omitted, removes everything.
 */
export async function drainDigestQueue(file: string, upToAt?: Date): Promise<void> {
  await withFileMutationQueue(file, async () => {
    if (upToAt === undefined) {
      await writeDigestQueue(file, []);
      return;
    }
    const cutoffMs = upToAt.getTime();
    const existing = await readDigestQueue(file);
    const remaining = existing.filter((item) => new Date(item.at).getTime() > cutoffMs);
    await writeDigestQueue(file, remaining);
  });
}
