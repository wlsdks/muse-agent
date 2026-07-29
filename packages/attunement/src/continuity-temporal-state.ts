import type { ResolvedArtifact } from "./types.js";

export const CONTINUITY_TEMPORAL_RULE_VERSION =
  "muse.continuity-temporal-state.v1" as const;

export type ContinuityTemporalStateField =
  | "taskDueState"
  | "reminderDueState"
  | "calendarTimeState";

export interface ContinuityTemporalStateEvaluation {
  readonly artifact: ResolvedArtifact;
  readonly coherent: boolean;
  readonly field?: ContinuityTemporalStateField;
}

function withoutTaskDue(
  artifact: ResolvedArtifact
): ResolvedArtifact {
  const {
    taskDueAt: _taskDueAt,
    taskDueState: _taskDueState,
    ...rest
  } = artifact;
  return rest;
}

function withoutTaskDueState(
  artifact: ResolvedArtifact
): ResolvedArtifact {
  const { taskDueState: _taskDueState, ...rest } = artifact;
  return rest;
}

function withoutReminderDue(
  artifact: ResolvedArtifact
): ResolvedArtifact {
  const {
    reminderDueAt: _reminderDueAt,
    reminderDueState: _reminderDueState,
    ...rest
  } = artifact;
  return rest;
}

function withoutReminderDueState(
  artifact: ResolvedArtifact
): ResolvedArtifact {
  const { reminderDueState: _reminderDueState, ...rest } = artifact;
  return rest;
}

function withoutCalendarTimeState(
  artifact: ResolvedArtifact
): ResolvedArtifact {
  const { calendarTimeState: _calendarTimeState, ...rest } = artifact;
  return rest;
}

/**
 * The single v1 owner of clock-relative Continuity display state.
 *
 * Producers consume `artifact`; receipt validation consumes `coherent`. The
 * implementation deliberately derives only display state and grants no source
 * freshness, causality, feedback, or action authority.
 */
export function evaluateContinuityTemporalState(
  artifact: ResolvedArtifact,
  observedAtMs: number
): ContinuityTemporalStateEvaluation {
  if (!Number.isFinite(observedAtMs)) {
    throw new TypeError("Continuity temporal evaluation requires a finite observedAt");
  }

  if (artifact.artifactType === "calendar-event") {
    const startsAt = artifact.calendarStartsAt === undefined
      ? Number.NaN
      : Date.parse(artifact.calendarStartsAt);
    const endsAt = artifact.calendarEndsAt === undefined
      ? Number.NaN
      : Date.parse(artifact.calendarEndsAt);
    if (
      Number.isFinite(startsAt)
      && Number.isFinite(endsAt)
      && endsAt >= startsAt
    ) {
      const expected: NonNullable<ResolvedArtifact["calendarTimeState"]> =
        endsAt < observedAtMs
        ? "ended"
        : startsAt <= observedAtMs
          ? "happening"
          : "upcoming";
      return Object.freeze({
        artifact: {
          ...artifact,
          calendarTimeState: expected
        },
        coherent: artifact.calendarTimeState === expected,
        ...(
          artifact.calendarTimeState === expected
            ? {}
            : { field: "calendarTimeState" as const }
        )
      });
    }
    const coherent = artifact.calendarTimeState === undefined;
    return Object.freeze({
      artifact: coherent ? artifact : withoutCalendarTimeState(artifact),
      coherent,
      ...(coherent ? {} : { field: "calendarTimeState" as const })
    });
  }

  if (artifact.artifactType === "task") {
    if (artifact.taskDueAt === undefined) {
      const coherent = artifact.taskDueState === undefined;
      return Object.freeze({
        artifact: coherent ? artifact : withoutTaskDueState(artifact),
        coherent,
        ...(coherent ? {} : { field: "taskDueState" as const })
      });
    }
    const dueAt = Date.parse(artifact.taskDueAt);
    if (!Number.isFinite(dueAt)) {
      return Object.freeze({
        artifact: withoutTaskDue(artifact),
        coherent: false,
        field: "taskDueState"
      });
    }
    const expected: NonNullable<ResolvedArtifact["taskDueState"]> =
      artifact.taskStatus === "open" && dueAt < observedAtMs
      ? "overdue"
      : "due";
    return Object.freeze({
      artifact: { ...artifact, taskDueState: expected },
      coherent: artifact.taskDueState === expected,
      ...(
        artifact.taskDueState === expected
          ? {}
          : { field: "taskDueState" as const }
      )
    });
  }

  if (artifact.artifactType === "reminder") {
    if (artifact.reminderDueAt === undefined) {
      const coherent = artifact.reminderDueState === undefined;
      return Object.freeze({
        artifact: coherent
          ? artifact
          : withoutReminderDueState(artifact),
        coherent,
        ...(coherent ? {} : { field: "reminderDueState" as const })
      });
    }
    const dueAt = Date.parse(artifact.reminderDueAt);
    if (!Number.isFinite(dueAt)) {
      return Object.freeze({
        artifact: withoutReminderDue(artifact),
        coherent: false,
        field: "reminderDueState"
      });
    }
    if (artifact.reminderStatus !== "pending") {
      const coherent = artifact.reminderDueState === undefined;
      return Object.freeze({
        artifact: coherent
          ? artifact
          : withoutReminderDueState(artifact),
        coherent,
        ...(coherent ? {} : { field: "reminderDueState" as const })
      });
    }
    const expected: NonNullable<ResolvedArtifact["reminderDueState"]> =
      dueAt < observedAtMs ? "overdue" : "due";
    return Object.freeze({
      artifact: { ...artifact, reminderDueState: expected },
      coherent: artifact.reminderDueState === expected,
      ...(
        artifact.reminderDueState === expected
          ? {}
          : { field: "reminderDueState" as const }
      )
    });
  }

  return Object.freeze({ artifact, coherent: true });
}
