/**
 * Persistence for the proactive-notice loop — the session-lock file (quiet
 * window after a manual `muse session lock`) and the fired-notice ledger (dedup
 * of already-surfaced calendar/task notices). Pure file I/O over node:fs, split
 * out of proactive-notice-loop.ts so the loop orchestration and its on-disk
 * state have separate homes.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export type ProactiveFiredKind = "calendar" | "task";

export interface ProactiveFiredEntry {
  /** Signal source. `calendar` = Phase A, `task` = Phase B. */
  readonly kind: ProactiveFiredKind;
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

const MAX_FIRED_ENTRIES = 1_000;

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
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  const fsm = await import("node:fs/promises");
  const pathMod = await import("node:path");
  await fsm.mkdir(pathMod.dirname(file), { recursive: true });
  await fsm.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsm.rename(tmp, file);
  await fsm.chmod(file, 0o600).catch(() => undefined);
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
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { fired?: unknown }).fired)) {
    return [];
  }
  return (parsed as { fired: unknown[] }).fired.flatMap((entry): readonly ProactiveFiredEntry[] =>
    isProactiveFiredEntry(entry) ? [entry] : []
  );
}

export async function writeProactiveFired(file: string, entries: readonly ProactiveFiredEntry[]): Promise<void> {
  // FIFO trim — keep the most recent N. A year of daily meetings
  // + tasks is ~700 entries so 1k is generous; the trim mainly
  // guards a pathological clock drift.
  const trimmed = entries.length > MAX_FIRED_ENTRIES
    ? entries.slice(entries.length - MAX_FIRED_ENTRIES)
    : entries;
  const payload = `${JSON.stringify({ fired: trimmed }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  // 0o600: entries reveal which calendar meetings + tasks have
  // fired when — sensitive user-data sidecar. Sibling personal
  // stores (calendar / tasks / episodes / credential-store /
  // inbox-injection-cursor) all use this posture; this was the
  // missed sibling.
  await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

function isProactiveFiredEntry(value: unknown): value is ProactiveFiredEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProactiveFiredEntry>;
  return (candidate.kind === "calendar" || candidate.kind === "task")
    && typeof candidate.id === "string"
    && typeof candidate.startIso === "string"
    && typeof candidate.firedAt === "string";
}

export function firedKey(entry: { readonly kind: string; readonly id: string; readonly startIso: string }): string {
  // Encode the tuple UNAMBIGUOUSLY (not a space-join): `id` is free-form (a provider
  // event / task id, can contain spaces), so `${kind} ${id} ${startIso}` lets two
  // distinct {kind,id,startIso} tuples collide on one key — the dedup would then
  // silently SUPPRESS a legitimate second notice. JSON escapes the field boundaries.
  return JSON.stringify([entry.kind, entry.id, entry.startIso]);
}
