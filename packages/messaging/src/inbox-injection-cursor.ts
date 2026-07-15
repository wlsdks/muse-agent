/**
 * Per-provider "last injected at" cursor for the agent-prompt
 * inbox-injection surface (Context Engineering Phase 2).
 *
 * Persists at `~/.muse/{providerId}-inbox-injection.json`. Schema is
 * versioned in-file so a v1 (single-user) install upgrades to v2
 * (multi-user) transparently on the first read.
 *
 * v1:
 *   { version: 1, lastInjectedAt: { [source]: ISO8601 } }
 * v2:
 *   { version: 2, byUser: { [userKey]: { [source]: ISO8601 } } }
 * v2 (current, per-source value):
 *   the inner `[source]` value is EITHER a bare ISO string (legacy,
 *   still accepted on read) OR `{ iso: ISO8601, ids: string[] }`. The
 *   `ids` are the messageIds surfaced AT the boundary `iso` — needed so
 *   a second distinct message sharing the boundary timestamp is not
 *   skipped by a timestamp-only `mm > lm` comparison.
 *
 * `userKey` is the caller's `userId` or the literal `"_global"` when
 * `userId` is omitted (single-user install). v1 data is migrated into
 * the `_global` slot on read, preserving the cursor state without
 * forcing a manual file fix.
 *
 * "source" mirrors `InboundMessage.source` — chat / channel / user id.
 * Telegram has a single global source which we key as `"_global"`.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { isRecord } from "@muse/shared";

const GLOBAL_USER_KEY = "_global";

/**
 * In-memory cursor for one source: the boundary instant plus the
 * messageIds surfaced exactly at that instant (the same-timestamp
 * tie-break set). `ids` is empty for legacy timestamp-only data.
 */
export interface SourceCursor {
  readonly iso: string;
  readonly ids: readonly string[];
}

export type InboxInjectionCursor = Readonly<Record<string, SourceCursor>>;
type PersistedByUser = Readonly<Record<string, InboxInjectionCursor>>;

interface PersistedShapeV2 {
  readonly version: 2;
  readonly byUser: Readonly<Record<string, Readonly<Record<string, SourceCursor>>>>;
}

function userKey(userId: string | undefined): string {
  if (!userId) return GLOBAL_USER_KEY;
  const trimmed = userId.trim();
  return trimmed.length === 0 ? GLOBAL_USER_KEY : trimmed;
}

function parseSourceCursor(value: unknown): SourceCursor | undefined {
  // Legacy timestamp-only shape: a bare ISO string.
  if (typeof value === "string") {
    return value.trim().length > 0 ? { ids: [], iso: value } : undefined;
  }
  if (isRecord(value)) {
    if (typeof value.iso === "string" && value.iso.trim().length > 0) {
      const ids = Array.isArray(value.ids)
        ? value.ids.filter((id): id is string => typeof id === "string")
        : [];
      return { ids, iso: value.iso };
    }
  }
  return undefined;
}

async function readPersisted(file: string): Promise<PersistedByUser> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  const versioned = parsed;
  if (versioned.version === 2 && isRecord(versioned.byUser)) {
    const out: Record<string, Record<string, SourceCursor>> = {};
    for (const [key, value] of Object.entries(versioned.byUser)) {
      if (isRecord(value)) {
        const inner: Record<string, SourceCursor> = {};
        for (const [source, raw] of Object.entries(value)) {
          const cursor = parseSourceCursor(raw);
          if (cursor) {
            inner[source] = cursor;
          }
        }
        out[key] = inner;
      }
    }
    return out;
  }
  // v1 migration: fold the flat map into the `_global` user slot.
  if (isRecord(versioned.lastInjectedAt)) {
    const inner: Record<string, SourceCursor> = {};
    for (const [source, raw] of Object.entries(versioned.lastInjectedAt)) {
      const cursor = parseSourceCursor(raw);
      if (cursor) {
        inner[source] = cursor;
      }
    }
    return { [GLOBAL_USER_KEY]: inner };
  }
  return {};
}

async function writePersisted(file: string, byUser: PersistedByUser): Promise<void> {
  const payload: PersistedShapeV2 = { byUser, version: 2 };
  // The tmp name MUST be unique per in-flight write: two concurrent
  // writes in the same millisecond+pid would otherwise pick the same
  // tmp path and one rename consumes the other's tmp → ENOENT / lost
  // update. A random uuid guarantees uniqueness.
  const tmp = `${file}.tmp-${process.pid.toString()}-${randomUUID()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

// Per-file mutation queue: writeInboxInjectionCursor / advanceInboxInjectionCursor
// are read-modify-write, so two concurrent calls would otherwise both read the
// same `existing` and the second write would clobber the first (last-writer-wins
// — a silently dropped cursor advance that re-injects an already-seen message).
// Serialising the WHOLE op per file makes the cursor lossless under concurrency,
// mirroring the pending-approval store.
const mutationQueues = new Map<string, Promise<unknown>>();
const resolvedPromise = async (): Promise<unknown> => undefined;
function serializePerFile<T>(file: string, op: () => Promise<T>): Promise<T> {
  const prior = mutationQueues.get(file) ?? resolvedPromise();
  const next = prior.then(op, op);
  mutationQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}

export async function readInboxInjectionCursor(
  file: string,
  userId?: string
): Promise<InboxInjectionCursor> {
  const byUser = await readPersisted(file);
  return byUser[userKey(userId)] ?? {};
}

export async function writeInboxInjectionCursor(
  file: string,
  cursor: InboxInjectionCursor,
  userId?: string
): Promise<void> {
  await serializePerFile(file, async () => {
    const existing = await readPersisted(file);
    const sanitized: Record<string, SourceCursor> = {};
    for (const [source, value] of Object.entries(cursor)) {
      if (value && typeof value.iso === "string" && value.iso.trim().length > 0) {
        sanitized[source] = { ids: [...value.ids], iso: value.iso };
      }
    }
    const next = { ...existing, [userKey(userId)]: sanitized };
    await writePersisted(file, next);
  });
}

/**
 * Merge an `advance` map into the persisted cursor for `userId`.
 * For each source the new boundary is written when it is a strictly
 * later instant than the existing one (replacing the tie-break id set);
 * when the new boundary equals the existing instant the surfaced ids
 * are UNIONED so the same-timestamp tie-break grows monotonically.
 * Other users' cursors are preserved untouched. Returns the merged
 * cursor for the supplied user so callers can avoid an extra read.
 */
export async function advanceInboxInjectionCursor(
  file: string,
  advance: Readonly<Record<string, SourceCursor>>,
  userId?: string
): Promise<InboxInjectionCursor> {
  return serializePerFile(file, async () => {
    const existing = await readPersisted(file);
    const key = userKey(userId);
    const current = existing[key] ?? {};
    const merged: Record<string, SourceCursor> = { ...current };
    for (const [source, value] of Object.entries(advance)) {
      // Compare parsed instants, not raw strings: lexicographic
      // ordering is wrong across mixed precision ("…01.500Z" sorts
      // BEFORE "…01Z") and timezone offsets, which would stall the
      // cursor and re-inject the same message every poll.
      const incoming = Date.parse(value.iso);
      if (Number.isNaN(incoming)) {
        continue;
      }
      const prior = merged[source];
      const priorTime = prior !== undefined ? Date.parse(prior.iso) : Number.NaN;
      if (Number.isNaN(priorTime) || incoming > priorTime) {
        merged[source] = { ids: [...value.ids], iso: value.iso };
      } else if (incoming === priorTime) {
        // Same boundary instant: union the surfaced ids so a second
        // distinct message at this timestamp isn't re-surfaced.
        const union = new Set<string>([...prior!.ids, ...value.ids]);
        merged[source] = { ids: [...union], iso: prior!.iso };
      }
    }
    const nextByUser = { ...existing, [key]: merged };
    await writePersisted(file, nextByUser);
    return merged;
  });
}
