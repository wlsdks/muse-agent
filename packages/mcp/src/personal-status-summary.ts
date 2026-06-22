/**
 * Pure summarizers over the four personal-JARVIS dashboard
 * stores. Used by both `loopback-status.ts` (`muse.status.snapshot`
 * MCP tool) and `apps/cli/src/commands-status.ts` (`muse status`
 * CLI command) once the CLI is refactored to consume these helpers.
 *
 * Functions take already-loaded rows so callers can choose their
 * own load strategy (typed `readReminders` vs ad-hoc JSON read).
 * No IO, no clock — pass `nowMs` for reminders so tests are
 * deterministic.
 *
 * Why a leaf module: the snapshot MCP server and the CLI status
 * command both need the same counting logic; duplicating it would
 * drift the moment one surface gains a field. Pattern matches
 * `personal-activity-feed.ts` — pure-data merge helpers
 * imported by both surfaces.
 */

import type { PersistedFollowup } from "@muse/stores";
import type { StandingObjective } from "@muse/stores";
import type { PersistedReminder } from "@muse/stores";

export interface RemindersSummary {
  readonly pending: number;
  readonly fired: number;
  readonly overdue: number;
  readonly total: number;
  readonly nextDueAt?: string;
  readonly nextText?: string;
}

export interface FollowupsSummary {
  readonly scheduled: number;
  readonly fired: number;
  readonly cancelled: number;
  readonly total: number;
  readonly nextScheduledFor?: string;
  readonly nextScheduledSummary?: string;
}

export interface EpisodesSummary {
  readonly total: number;
  readonly lastEndedAt?: string;
  readonly lastSummary?: string;
}

export interface PatternsFiredSummary {
  readonly total: number;
  readonly lastFiredAtIso?: string;
}

export interface ObjectivesSummary {
  readonly total: number;
  readonly active: number;
  readonly escalated: number;
  readonly done: number;
  readonly cancelled: number;
  /** First escalated objective's spec — the needs-you signal worth surfacing. */
  readonly escalatedSample?: string;
}

/**
 * Summarise standing objectives (the delegated-autonomy store) for the
 * dashboard. User-scoped like followups. `escalated` is the high-value
 * signal — a delegated objective that hit a wall and needs the user —
 * so the first escalated objective's spec is surfaced.
 */
export function summariseObjectivesRows(rows: readonly StandingObjective[], userId: string): ObjectivesSummary {
  let total = 0;
  let active = 0;
  let escalated = 0;
  let done = 0;
  let cancelled = 0;
  let escalatedSample: string | undefined;
  for (const row of rows) {
    if (typeof row.userId !== "string" || row.userId !== userId) continue;
    total += 1;
    if (row.status === "active") {
      active += 1;
    } else if (row.status === "escalated") {
      escalated += 1;
      if (escalatedSample === undefined && typeof row.spec === "string" && row.spec.length > 0) {
        escalatedSample = row.spec;
      }
    } else if (row.status === "done") {
      done += 1;
    } else if (row.status === "cancelled") {
      cancelled += 1;
    }
  }
  return { active, cancelled, done, escalated, total, ...(escalatedSample ? { escalatedSample } : {}) };
}

/**
 * Reminders are single-user — there is no userId on the row.
 * Overdue = pending && dueAt in the past. Next = earliest pending
 * dueAt (regardless of whether it's overdue, so the snapshot
 * still points at the next thing to deal with, not just the next
 * thing in the future).
 */
export function summariseRemindersRows(rows: readonly PersistedReminder[], nowMs: number): RemindersSummary {
  let pending = 0;
  let fired = 0;
  let overdue = 0;
  let total = 0;
  let nextDueAtMs = Number.POSITIVE_INFINITY;
  let nextDueAt: string | undefined;
  let nextText: string | undefined;
  for (const row of rows) {
    if (typeof row.id !== "string") continue;
    total += 1;
    if (row.status === "fired") {
      fired += 1;
      continue;
    }
    if (row.status !== "pending") continue;
    pending += 1;
    if (typeof row.dueAt !== "string") continue;
    const ms = Date.parse(row.dueAt);
    if (!Number.isFinite(ms)) continue;
    if (ms < nowMs) overdue += 1;
    if (ms < nextDueAtMs) {
      nextDueAtMs = ms;
      nextDueAt = row.dueAt;
      nextText = typeof row.text === "string" ? row.text : undefined;
    }
  }
  return { fired, nextDueAt, nextText, overdue, pending, total };
}

/**
 * Filters to the active userId so a shared install doesn't surface
 * other personas' queues. Returns the earliest scheduled followup's
 * scheduledFor + summary as `nextScheduledFor` / `nextScheduledSummary`.
 */
export function summariseFollowupsRows(rows: readonly PersistedFollowup[], userId: string): FollowupsSummary {
  let scheduled = 0;
  let fired = 0;
  let cancelled = 0;
  let nextScheduledForMs = Number.POSITIVE_INFINITY;
  let nextScheduledFor: string | undefined;
  let nextScheduledSummary: string | undefined;
  let total = 0;
  for (const row of rows) {
    if (typeof row.userId !== "string" || row.userId !== userId) continue;
    total += 1;
    if (row.status === "scheduled") {
      scheduled += 1;
      if (typeof row.scheduledFor === "string") {
        const ms = Date.parse(row.scheduledFor);
        if (Number.isFinite(ms) && ms < nextScheduledForMs) {
          nextScheduledForMs = ms;
          nextScheduledFor = row.scheduledFor;
          nextScheduledSummary = typeof row.summary === "string" ? row.summary : undefined;
        }
      }
    } else if (row.status === "fired") {
      fired += 1;
    } else if (row.status === "cancelled") {
      cancelled += 1;
    }
  }
  return { cancelled, fired, nextScheduledFor, nextScheduledSummary, scheduled, total };
}

interface EpisodeRow {
  readonly id?: unknown;
  readonly userId?: unknown;
  readonly endedAt?: unknown;
  readonly summary?: unknown;
}

/**
 * `{ total, lastEndedAt, lastSummary }` filtered to the active
 * user. EpisodeRow is intentionally untyped here so the helper
 * can consume raw rows read via `safeReadJson` without forcing the
 * caller to validate against a full schema first.
 */
export function summariseEpisodesRows(rows: readonly unknown[], userId: string): EpisodesSummary {
  let total = 0;
  let lastEndedMs = Number.NEGATIVE_INFINITY;
  let lastEndedAt: string | undefined;
  let lastSummary: string | undefined;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as EpisodeRow;
    if (typeof row.userId !== "string" || row.userId !== userId) continue;
    total += 1;
    // Compare parsed instants, not raw strings: endedAt is a
    // free-form timestamp (runtime-written / imported / hand-
    // edited), and lexicographic ISO order is wrong across mixed
    // sub-second precision and timezone offsets — it would surface
    // the wrong episode as the most recent one. Mirrors the
    // sibling reminder/followup/patterns summarisers.
    if (typeof row.endedAt === "string") {
      const ms = Date.parse(row.endedAt);
      if (Number.isFinite(ms) && ms > lastEndedMs) {
        lastEndedMs = ms;
        lastEndedAt = row.endedAt;
        lastSummary = typeof row.summary === "string" ? row.summary : undefined;
      }
    }
  }
  return { lastEndedAt, lastSummary, total };
}

interface PatternFiredRow {
  readonly patternId?: unknown;
  readonly firedAtMs?: unknown;
}

/**
 * `{ total, lastFiredAtIso }` over the cooldown sidecar. The
 * patterns-fired file is single-user by design (no userId).
 */
export function summarisePatternsFiredRows(rows: readonly unknown[]): PatternsFiredSummary {
  let total = 0;
  let lastFiredMs = Number.NEGATIVE_INFINITY;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as PatternFiredRow;
    if (typeof row.patternId !== "string") continue;
    total += 1;
    // A finite but out-of-range ms (corrupt / hand-edited
    // sidecar) makes an Invalid Date whose toISOString() throws;
    // reject it here so it can't win the max and poison a valid
    // sibling row either.
    if (typeof row.firedAtMs === "number"
      && Number.isFinite(new Date(row.firedAtMs).getTime())
      && row.firedAtMs > lastFiredMs) {
      lastFiredMs = row.firedAtMs;
    }
  }
  return {
    lastFiredAtIso: lastFiredMs > Number.NEGATIVE_INFINITY ? new Date(lastFiredMs).toISOString() : undefined,
    total
  };
}
