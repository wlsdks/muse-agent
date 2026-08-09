import { createHash } from "node:crypto";

export type FollowupRecurrence =
  | {
      readonly kind: "daily";
      readonly hour: number;
      readonly minute: number;
    }
  | {
      readonly kind: "weekdays";
      readonly hour: number;
      readonly minute: number;
    }
  | {
      readonly kind: "weekly";
      readonly weekday: number;
      readonly hour: number;
      readonly minute: number;
    }
  | {
      readonly kind: "monthly";
      readonly dayOfMonth: number;
      readonly hour: number;
      readonly minute: number;
    }
  | {
      readonly kind: "nth-weekday";
      readonly ordinal: number;
      readonly weekday: number;
      readonly hour: number;
      readonly minute: number;
    };

export const FOLLOWUP_COMMITMENT_TEXT_MAX_CHARS = 160;

type RecurrenceWithClock = { readonly hour: number; readonly minute: number };

export function isFollowupRecurrence(value: unknown): value is FollowupRecurrence {
  return normalizeFollowupRecurrence(value) !== undefined;
}

/** Normalize and validate the persisted recurrence vocabulary. */
export function normalizeFollowupRecurrence(value: unknown): FollowupRecurrence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.kind !== "string") return undefined;
  if (!validClock(candidate)) return undefined;

  if (candidate.kind === "daily" && hasOnlyKeys(candidate, ["kind", "hour", "minute"])) {
    return { kind: "daily", hour: candidate.hour as number, minute: candidate.minute as number };
  }
  if (candidate.kind === "weekdays" && hasOnlyKeys(candidate, ["kind", "hour", "minute"])) {
    return { kind: "weekdays", hour: candidate.hour as number, minute: candidate.minute as number };
  }
  if (candidate.kind === "weekly"
    && hasOnlyKeys(candidate, ["kind", "weekday", "hour", "minute"])
    && integerInRange(candidate.weekday, 0, 6)) {
    return {
      kind: "weekly",
      weekday: candidate.weekday as number,
      hour: candidate.hour as number,
      minute: candidate.minute as number
    };
  }
  if (candidate.kind === "monthly"
    && hasOnlyKeys(candidate, ["kind", "dayOfMonth", "hour", "minute"])
    && integerInRange(candidate.dayOfMonth, 1, 31)) {
    return {
      kind: "monthly",
      dayOfMonth: candidate.dayOfMonth as number,
      hour: candidate.hour as number,
      minute: candidate.minute as number
    };
  }
  if (candidate.kind === "nth-weekday"
    && hasOnlyKeys(candidate, ["kind", "ordinal", "weekday", "hour", "minute"])
    && integerInRange(candidate.ordinal, 1, 5)
    && integerInRange(candidate.weekday, 0, 6)) {
    return {
      kind: "nth-weekday",
      ordinal: candidate.ordinal as number,
      weekday: candidate.weekday as number,
      hour: candidate.hour as number,
      minute: candidate.minute as number
    };
  }
  return undefined;
}

/** Stable JSON for keys and persistence; property order is part of the contract. */
export function canonicalFollowupRecurrenceJson(recurrence: FollowupRecurrence | undefined): string {
  if (recurrence === undefined) return "null";
  const normalized = normalizeFollowupRecurrence(recurrence);
  if (!normalized) throw new TypeError("invalid follow-up recurrence");
  switch (normalized.kind) {
    case "daily":
      return JSON.stringify({ kind: "daily", hour: normalized.hour, minute: normalized.minute });
    case "weekdays":
      return JSON.stringify({ kind: "weekdays", hour: normalized.hour, minute: normalized.minute });
    case "weekly":
      return JSON.stringify({ kind: "weekly", weekday: normalized.weekday, hour: normalized.hour, minute: normalized.minute });
    case "monthly":
      return JSON.stringify({ kind: "monthly", dayOfMonth: normalized.dayOfMonth, hour: normalized.hour, minute: normalized.minute });
    case "nth-weekday":
      return JSON.stringify({
        kind: "nth-weekday",
        ordinal: normalized.ordinal,
        weekday: normalized.weekday,
        hour: normalized.hour,
        minute: normalized.minute
      });
  }
}

/** Normalize owner text before it participates in a follow-up identity. */
export function normalizeFollowupCommitmentText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .slice(0, FOLLOWUP_COMMITMENT_TEXT_MAX_CHARS)
    .trim();
}

/** Stable identity for a user, normalized commitment, and exact recurrence rule. */
export function followupCommitmentKey(
  userId: string,
  commitmentText: string,
  recurrence: FollowupRecurrence | undefined
): string {
  const payload = JSON.stringify([
    userId,
    normalizeFollowupCommitmentText(commitmentText),
    canonicalFollowupRecurrenceJson(recurrence)
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Return the first occurrence strictly after `after` in the host-local clock.
 * JavaScript Date construction owns DST gap/fold normalization.
 */
export function nextFollowupOccurrence(after: Date, recurrence: FollowupRecurrence): Date | undefined {
  const normalized = normalizeFollowupRecurrence(recurrence);
  const afterMs = after.getTime();
  if (!normalized || !Number.isFinite(afterMs)) return undefined;

  switch (normalized.kind) {
    case "daily":
      return findDaily(after, normalized);
    case "weekdays":
      return findWeekdays(after, normalized);
    case "weekly":
      return findWeekly(after, normalized);
    case "monthly":
      return findMonthly(after, normalized);
    case "nth-weekday":
      return findNthWeekday(after, normalized);
  }
}

function validClock(value: Record<string, unknown>): value is Record<string, number | string> & RecurrenceWithClock {
  return integerInRange(value.hour, 0, 23) && integerInRange(value.minute, 0, 59);
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function findDaily(after: Date, recurrence: Extract<FollowupRecurrence, { readonly kind: "daily" }>): Date | undefined {
  for (let offset = 0; offset <= 2; offset += 1) {
    const date = localDateAtStart(after);
    date.setDate(date.getDate() + offset);
    const candidate = localDateTime(date, recurrence.hour, recurrence.minute);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return undefined;
}

function findWeekdays(after: Date, recurrence: Extract<FollowupRecurrence, { readonly kind: "weekdays" }>): Date | undefined {
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = localDateAtStart(after);
    date.setDate(date.getDate() + offset);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const candidate = localDateTime(date, recurrence.hour, recurrence.minute);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return undefined;
}

function findWeekly(after: Date, recurrence: Extract<FollowupRecurrence, { readonly kind: "weekly" }>): Date | undefined {
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = localDateAtStart(after);
    date.setDate(date.getDate() + offset);
    if (date.getDay() !== recurrence.weekday) continue;
    const candidate = localDateTime(date, recurrence.hour, recurrence.minute);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return undefined;
}

function findMonthly(after: Date, recurrence: Extract<FollowupRecurrence, { readonly kind: "monthly" }>): Date | undefined {
  const cursor = localDateAtStart(after);
  cursor.setDate(1);
  for (let monthOffset = 0; monthOffset <= 4_800; monthOffset += 1) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    if (recurrence.dayOfMonth <= daysInMonth(year, month)) {
      const candidate = localDateTime(new Date(year, month, recurrence.dayOfMonth), recurrence.hour, recurrence.minute);
      if (candidate.getTime() > after.getTime()) return candidate;
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return undefined;
}

function findNthWeekday(after: Date, recurrence: Extract<FollowupRecurrence, { readonly kind: "nth-weekday" }>): Date | undefined {
  const cursor = localDateAtStart(after);
  cursor.setDate(1);
  for (let monthOffset = 0; monthOffset <= 4_800; monthOffset += 1) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const day = nthWeekdayDay(year, month, recurrence.weekday, recurrence.ordinal);
    if (day !== undefined) {
      const candidate = localDateTime(new Date(year, month, day), recurrence.hour, recurrence.minute);
      if (candidate.getTime() > after.getTime()) return candidate;
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return undefined;
}

function localDateAtStart(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function localDateTime(date: Date, hour: number, minute: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function nthWeekdayDay(year: number, month: number, weekday: number, ordinal: number): number | undefined {
  const first = new Date(year, month, 1, 0, 0, 0, 0);
  const offset = (weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (ordinal - 1) * 7;
  return day <= daysInMonth(year, month) ? day : undefined;
}
