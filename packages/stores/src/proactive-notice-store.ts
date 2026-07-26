/**
 * Persistence for the proactive-notice loop — the session-lock file (quiet
 * window after a manual `muse session lock`) and the fired-notice ledger (dedup
 * of already-surfaced calendar/task notices). Pure file I/O over node:fs, split
 * out of proactive-notice-loop.ts so the loop orchestration and its on-disk
 * state have separate homes.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile } from "./atomic-file-store.js";

export type ProactiveFiredKind = "calendar" | "task";

interface ProactiveFiredEntryBase {
  /** Provider-reported event id, or task id. */
  readonly id: string;
  /**
   * For calendar items: event `startsAt` (ISO). For task items:
   * task `dueAt` (ISO). Included in the dedupe key so a moved
   * meeting / rescheduled task (same id, new time) re-fires.
   */
  readonly startIso: string;
  /** When the notice was delivered (or attempted). */
  readonly firedAt: string;
}

export interface TaskProactiveFiredEntry extends ProactiveFiredEntryBase {
  readonly kind: "task";
}

/**
 * Calendar occurrence written before provider provenance was available.
 * It remains a conservative wildcard for this exact legacy id/start pair
 * and is never assigned a provider during read or write.
 */
export interface LegacyCalendarProactiveFiredEntry extends ProactiveFiredEntryBase {
  readonly kind: "calendar";
}

export interface QualifiedCalendarProactiveFiredEntry extends ProactiveFiredEntryBase {
  readonly kind: "calendar";
  readonly providerId: string;
  readonly providerEventId?: string;
}

export type ProactiveFiredEntry =
  | TaskProactiveFiredEntry
  | LegacyCalendarProactiveFiredEntry
  | QualifiedCalendarProactiveFiredEntry;

export class ProactiveFiredStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProactiveFiredStoreError";
  }
}

const MAX_FIRED_ENTRIES = 1_000;
const FIRED_LEDGER_VERSION = 2;

/**
 * Payload of `~/.muse/session-lock.json`. Written by
 * `muse session lock --hours N`, read by `runDueProactiveNotices`
 * to gate firing. The `reason` field is optional and exists so the
 * user can write "deep work" / "PR review" / etc. — surfaced in
 * the daemon log and `muse session status`.
 */
export interface SessionLockPayload {
  readonly until: string;
  readonly setAt: string;
  readonly reason?: string;
}

/**
 * Write a fresh session-lock marker. Atomic write via
 * tmp+rename + 0o600 file mode to match the other personal stores.
 */
export async function writeSessionLock(file: string, payload: SessionLockPayload): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Best-effort read + expiry check. Returns the `until`
 * ISO string when the lock is still active at `nowDate`; otherwise
 * `undefined`. Tolerant: any read / JSON / shape error treats the
 * session as unlocked (fail-open) so a corrupted marker cannot
 * permanently silence the daemon.
 */
export async function readSessionLock(file: string, nowDate: Date): Promise<string | undefined> {
  let raw: string;
  try {
    const fsm = await import("node:fs/promises");
    raw = await fsm.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const until = (parsed as { until?: unknown }).until;
  if (typeof until !== "string") return undefined;
  const expiresAt = new Date(until);
  if (Number.isNaN(expiresAt.getTime())) return undefined;
  if (expiresAt.getTime() <= nowDate.getTime()) return undefined;
  return until;
}

export async function readProactiveFired(file: string): Promise<readonly ProactiveFiredEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ProactiveFiredStoreError("proactive fired ledger could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ProactiveFiredStoreError("proactive fired ledger contains malformed JSON");
  }
  if (hasExactKeys(parsed, ["fired"])) {
    const legacy = parsed as Record<string, unknown>;
    if (!Array.isArray(legacy.fired)) {
      throw new ProactiveFiredStoreError("legacy proactive fired ledger has an invalid fired collection");
    }
    return legacy.fired.map((entry) => parseLegacyEntry(entry));
  }
  if (!hasExactKeys(parsed, ["fired", "version"])) {
    throw new ProactiveFiredStoreError("proactive fired ledger has an unsupported top-level schema");
  }
  const current = parsed as Record<string, unknown>;
  if (current.version !== FIRED_LEDGER_VERSION) {
    throw new ProactiveFiredStoreError("proactive fired ledger version is unsupported");
  }
  if (!Array.isArray(current.fired)) {
    throw new ProactiveFiredStoreError("proactive fired ledger has an invalid fired collection");
  }
  return current.fired.map((entry) => parseV2Entry(entry));
}

export async function writeProactiveFired(file: string, entries: readonly ProactiveFiredEntry[]): Promise<void> {
  const validated = entries.map((entry) => parseV2Entry(entry));
  // FIFO trim — keep the most recent N. A year of daily meetings
  // + tasks is ~700 entries so 1k is generous; the trim mainly
  // guards a pathological clock drift.
  const trimmed = validated.length > MAX_FIRED_ENTRIES
    ? validated.slice(validated.length - MAX_FIRED_ENTRIES)
    : validated;
  // 0o600 (atomicWriteFile default): entries reveal which calendar meetings +
  // tasks fired when — a sensitive user-data sidecar, same posture as the
  // sibling personal stores (calendar / tasks / episodes / credentials).
  const payload = `${JSON.stringify({ version: FIRED_LEDGER_VERSION, fired: trimmed }, null, 2)}\n`;
  await atomicWriteFile(file, payload);
}

function parseLegacyEntry(value: unknown): ProactiveFiredEntry {
  if (!hasExactKeys(value, ["firedAt", "id", "kind", "startIso"])) {
    throw new ProactiveFiredStoreError("legacy proactive fired ledger contains an invalid entry");
  }
  const candidate = value as Record<string, unknown>;
  const base = parseBaseEntry(candidate);
  if (candidate.kind !== "calendar" && candidate.kind !== "task") {
    throw new ProactiveFiredStoreError("legacy proactive fired ledger contains an unsupported entry kind");
  }
  return candidate.kind === "calendar"
    ? { ...base, kind: "calendar" }
    : { ...base, kind: "task" };
}

function parseV2Entry(value: unknown): ProactiveFiredEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProactiveFiredStoreError("proactive fired ledger contains an invalid entry");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "task") {
    if (!hasExactKeys(candidate, ["firedAt", "id", "kind", "startIso"])) {
      throw new ProactiveFiredStoreError("proactive fired ledger contains an invalid task entry");
    }
    const base = parseBaseEntry(candidate);
    return {
      ...base,
      kind: "task",
    };
  }
  if (candidate.kind !== "calendar") {
    throw new ProactiveFiredStoreError("proactive fired ledger contains an unsupported entry kind");
  }
  const legacy = hasExactKeys(candidate, ["firedAt", "id", "kind", "startIso"]);
  const qualified = hasExactKeys(candidate, ["firedAt", "id", "kind", "providerId", "startIso"]);
  const qualifiedExact = hasExactKeys(
    candidate,
    ["firedAt", "id", "kind", "providerEventId", "providerId", "startIso"]
  );
  if (!legacy && !qualified && !qualifiedExact) {
    throw new ProactiveFiredStoreError("proactive fired ledger contains invalid calendar provenance");
  }
  const base = parseBaseEntry(candidate);
  if (legacy) {
    return {
      ...base,
      kind: "calendar",
    };
  }
  const providerId = parseExactText(candidate.providerId, "calendar providerId");
  const providerEventId = qualifiedExact
    ? parseExactText(candidate.providerEventId, "calendar providerEventId")
    : undefined;
  return {
    ...base,
    kind: "calendar",
    ...(providerEventId !== undefined ? { providerEventId } : {}),
    providerId
  };
}

function parseBaseEntry(value: Record<string, unknown>): ProactiveFiredEntryBase {
  return {
    firedAt: parseTimestamp(value.firedAt, "firedAt"),
    id: parseNonEmptyText(value.id, "id"),
    startIso: parseTimestamp(value.startIso, "startIso")
  };
}

function parseNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProactiveFiredStoreError(`proactive fired entry has an invalid ${field}`);
  }
  return value;
}

function parseExactText(value: unknown, field: string): string {
  const text = parseNonEmptyText(value, field);
  if (text !== text.trim()) {
    throw new ProactiveFiredStoreError(`proactive fired entry has an invalid ${field}`);
  }
  return text;
}

function parseTimestamp(value: unknown, field: string): string {
  const text = parseNonEmptyText(value, field);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new ProactiveFiredStoreError(`proactive fired entry has an invalid ${field}`);
  }
  return text;
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

type ProactiveFiredKeyInput =
  | Pick<TaskProactiveFiredEntry, "id" | "kind" | "startIso">
  | Pick<LegacyCalendarProactiveFiredEntry, "id" | "kind" | "startIso">
  | Pick<QualifiedCalendarProactiveFiredEntry, "id" | "kind" | "providerEventId" | "providerId" | "startIso">;

export function firedKey(entry: ProactiveFiredKeyInput): string {
  const id = parseNonEmptyText(entry.id, "id");
  const startIso = parseTimestamp(entry.startIso, "startIso");
  if (entry.kind === "task") {
    return JSON.stringify(["task", id, startIso]);
  }
  if ("providerId" in entry) {
    const providerId = parseExactText(entry.providerId, "calendar providerId");
    const providerEventId = entry.providerEventId === undefined
      ? id
      : parseExactText(entry.providerEventId, "calendar providerEventId");
    return JSON.stringify([
      "calendar",
      providerId,
      providerEventId,
      startIso
    ]);
  }
  return legacyCalendarWildcardKey({ id, startIso });
}

export function legacyCalendarWildcardKey(
  entry: { readonly id: string; readonly startIso: string }
): string {
  return JSON.stringify([
    "calendar-legacy-wildcard",
    parseNonEmptyText(entry.id, "id"),
    parseTimestamp(entry.startIso, "startIso")
  ]);
}
