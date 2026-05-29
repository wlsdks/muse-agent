/**
 * Commitment check-ins — turn a user's detected open-loop ("I have an
 * interview tomorrow", "내일 자료 준비해야 해") into a due-windowed proactive
 * check-in the daemon delivers later ("요전에 … 하셨는데, 어떻게 됐어요?").
 *
 * This is the DELIVERY half of the open-loop story: `detectUserCommitments`
 * (agent-core) finds the commitment; `scheduleCheckins` schedules a
 * due-windowed, rate-limited, deduped check-in; `runDueCheckins` fires the due
 * ones to the USER's own channel (low-risk reply-to-user path, never a
 * third-party send), quiet-hours-aware. The check-in text is templated
 * (deterministic) — no model call, so it can't fabricate.
 *
 * Pattern adapted from OpenClaw's commitment-extraction → heartbeat delivery
 * (due-window + per-day cap) (MIT) — reimplemented for Muse, no code copied.
 * See THIRD_PARTY_NOTICES.md.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { isQuietHour, type QuietHourRange } from "./quiet-hours.js";

export type CheckinStatus = "scheduled" | "fired" | "cancelled";

export interface PersistedCheckin {
  readonly id: string;
  readonly userId: string;
  /** The user's open-loop commitment text (verbatim, from the detector). */
  readonly commitment: string;
  /** The templated question delivered at due time. */
  readonly question: string;
  /** ISO timestamp the check-in becomes due. */
  readonly dueAtIso: string;
  readonly createdAt: string;
  readonly status: CheckinStatus;
  readonly firedAt?: string;
  /** Normalised commitment, the dedup key (don't re-schedule the same loop). */
  readonly sourceKey: string;
}

const HANGUL = /[가-힣]/u;

/** Templated, language-matched check-in question. Deterministic — no model. */
export function buildCheckinQuestion(commitment: string): string {
  const c = commitment.trim().replace(/\s+/gu, " ");
  return HANGUL.test(c)
    ? `요전에 "${c}" 하신다고 하셨는데, 어떻게 됐어요?`
    : `Following up — you mentioned you'd "${c}". How did it go?`;
}

function normaliseKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, " ");
}

export interface ScheduleCheckinsOptions {
  readonly now: Date;
  readonly userId: string;
  /** Local hour the next-day check-in fires. Default 10. */
  readonly slotHour?: number;
  /** Max NEW check-ins scheduled per calendar day. Default 3. */
  readonly maxPerDay?: number;
  /** Already-stored check-ins (for dedup + per-day cap). */
  readonly existing?: readonly PersistedCheckin[];
  readonly idFactory?: () => string;
}

/**
 * Schedule due-windowed check-ins from detected commitments. Each fires
 * next-day at `slotHour`. Skips a commitment already tracked (same sourceKey,
 * not cancelled). Caps NEW scheduals so today's batch + today's existing
 * scheduled never exceed `maxPerDay` (no nagging). Pure: returns the NEW
 * records to persist (does not include `existing`).
 */
export function scheduleCheckins(
  commitments: readonly string[],
  options: ScheduleCheckinsOptions
): readonly PersistedCheckin[] {
  const slotHour = Number.isFinite(options.slotHour) ? Math.max(0, Math.min(23, Math.trunc(options.slotHour as number))) : 10;
  const maxPerDay = Number.isFinite(options.maxPerDay) ? Math.max(1, Math.trunc(options.maxPerDay as number)) : 3;
  const existing = options.existing ?? [];
  const now = options.now;
  const createdAt = now.toISOString();
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, slotHour, 0, 0, 0);
  const dueAtIso = due.toISOString();
  const idFactory = options.idFactory ?? ((): string => `chk_${now.getTime().toString(36)}_${Math.trunc((due.getTime() % 1_000_000)).toString(36)}`);

  const taken = new Set(existing.filter((c) => c.status !== "cancelled").map((c) => c.sourceKey));
  const scheduledToday = existing.filter((c) => c.status === "scheduled" && c.createdAt.slice(0, 10) === createdAt.slice(0, 10)).length;

  const out: PersistedCheckin[] = [];
  let budget = Math.max(0, maxPerDay - scheduledToday);
  for (const raw of commitments) {
    if (budget <= 0) break;
    const commitment = raw.trim();
    if (commitment.length < 2) continue;
    const sourceKey = normaliseKey(commitment);
    if (taken.has(sourceKey)) continue;
    taken.add(sourceKey);
    out.push({
      commitment,
      createdAt,
      dueAtIso,
      id: idFactory(),
      question: buildCheckinQuestion(commitment),
      sourceKey,
      status: "scheduled",
      userId: options.userId
    });
    budget -= 1;
  }
  return out;
}

async function writeFileAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

export async function readCheckins(file: string): Promise<readonly PersistedCheckin[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PersistedCheckin =>
        Boolean(e) && typeof e === "object"
        && typeof (e as PersistedCheckin).id === "string"
        && typeof (e as PersistedCheckin).question === "string"
        && typeof (e as PersistedCheckin).dueAtIso === "string"
    );
  } catch {
    return [];
  }
}

export async function writeCheckins(file: string, checkins: readonly PersistedCheckin[]): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(checkins, null, 2)}\n`);
}

/** Append newly-scheduled check-ins to the store (in addition to existing). */
export async function appendCheckins(file: string, fresh: readonly PersistedCheckin[]): Promise<void> {
  if (fresh.length === 0) return;
  const existing = await readCheckins(file);
  await writeCheckins(file, [...existing, ...fresh]);
}

export interface CheckinSendRegistry {
  send(providerId: string, message: { readonly destination: string; readonly text: string }): Promise<unknown>;
}

export interface RunDueCheckinsOptions {
  readonly file: string;
  readonly registry: CheckinSendRegistry;
  readonly providerId: string;
  readonly destination: string;
  readonly now?: () => Date;
  readonly maxPerTick?: number;
  /** When set and the current hour is within it, hold ALL check-ins (DND). */
  readonly quietHours?: QuietHourRange;
}

export interface RunDueCheckinsSummary {
  readonly delivered: number;
  readonly due: number;
  readonly errors: readonly string[];
  readonly fired: readonly PersistedCheckin[];
}

/**
 * Deliver due check-ins to the user's channel. Quiet-hours holds the whole
 * tick (they fire once the window passes — the edge isn't consumed). Fires at
 * most `maxPerTick` (default 5). Marks each fired; a send failure leaves it
 * scheduled to retry next tick. Reply-to-user channel only — never a
 * third-party send.
 */
export async function runDueCheckins(options: RunDueCheckinsOptions): Promise<RunDueCheckinsSummary> {
  const now = options.now ?? ((): Date => new Date());
  const at = now();
  if (options.quietHours && isQuietHour(at.getHours(), options.quietHours)) {
    return { delivered: 0, due: 0, errors: [], fired: [] };
  }
  const max = Number.isFinite(options.maxPerTick) ? Math.max(1, Math.trunc(options.maxPerTick as number)) : 5;
  const all = await readCheckins(options.file);
  const cutoff = at.getTime();
  const due = all.filter((c) => c.status === "scheduled" && Date.parse(c.dueAtIso) <= cutoff).slice(0, max);
  if (due.length === 0) {
    return { delivered: 0, due: 0, errors: [], fired: [] };
  }
  const firedIds = new Set<string>();
  const fired: PersistedCheckin[] = [];
  const errors: string[] = [];
  for (const checkin of due) {
    try {
      await options.registry.send(options.providerId, { destination: options.destination, text: checkin.question });
      firedIds.add(checkin.id);
      fired.push({ ...checkin, firedAt: at.toISOString(), status: "fired" });
    } catch (cause) {
      errors.push(`${checkin.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (firedIds.size > 0) {
    const next = all.map((c) => (firedIds.has(c.id) ? { ...c, firedAt: at.toISOString(), status: "fired" as const } : c));
    await writeCheckins(options.file, next);
  }
  return { delivered: fired.length, due: due.length, errors, fired };
}
