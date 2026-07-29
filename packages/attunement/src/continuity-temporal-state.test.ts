import { describe, expect, it } from "vitest";

import {
  CONTINUITY_TEMPORAL_RULE_VERSION,
  evaluateContinuityTemporalState
} from "./continuity-temporal-state.js";
import type { ResolvedArtifact } from "./types.js";

const OBSERVED_AT = Date.parse("2026-07-29T09:00:00.000Z");

function artifact(
  artifactType: ResolvedArtifact["artifactType"],
  fields: Partial<ResolvedArtifact> = {}
): ResolvedArtifact {
  return {
    artifactId: `${artifactType}_1`,
    artifactType,
    providerId: artifactType === "calendar-event"
      ? "calendar:gcal"
      : artifactType === "resource"
        ? "mcp:github"
        : "local",
    role: "context",
    title: `${artifactType} title`,
    ...fields
  };
}

describe("evaluateContinuityTemporalState", () => {
  it("pins the receipt-compatible temporal rule version", () => {
    expect(CONTINUITY_TEMPORAL_RULE_VERSION).toBe(
      "muse.continuity-temporal-state.v1"
    );
  });

  it.each([
    ["2026-07-29T09:00:00.000Z", "open", "due"],
    ["2026-07-29T08:59:59.999Z", "open", "overdue"],
    ["2026-07-29T08:59:59.999Z", "done", "due"],
    ["2026-07-29T09:00:00.001Z", "open", "due"]
  ] as const)(
    "derives task due state for %s / %s",
    (taskDueAt, taskStatus, expected) => {
      const source = artifact("task", {
        role: "next-step",
        taskDueAt,
        taskStatus
      });
      const result = evaluateContinuityTemporalState(source, OBSERVED_AT);
      expect(result.artifact.taskDueState).toBe(expected);
      expect(result.coherent).toBe(false);

      const replay = evaluateContinuityTemporalState(
        result.artifact,
        OBSERVED_AT
      );
      expect(replay.coherent).toBe(true);
      expect(replay.field).toBeUndefined();
    }
  );

  it.each([
    ["2026-07-29T09:00:00.000Z", "pending", "due"],
    ["2026-07-29T08:59:59.999Z", "pending", "overdue"],
    ["2026-07-29T09:00:00.001Z", "pending", "due"],
    ["2026-07-29T08:59:59.999Z", "fired", undefined]
  ] as const)(
    "derives reminder due state for %s / %s",
    (reminderDueAt, reminderStatus, expected) => {
      const source = artifact("reminder", {
        reminderDueAt,
        reminderDueState: "overdue",
        reminderStatus
      });
      const result = evaluateContinuityTemporalState(source, OBSERVED_AT);
      expect(result.artifact.reminderDueState).toBe(expected);
      expect(result.coherent).toBe(
        reminderStatus === "pending" && expected === "overdue"
      );
    }
  );

  it.each([
    [
      "2026-07-29T09:00:00.000Z",
      "2026-07-29T10:00:00.000Z",
      "happening"
    ],
    [
      "2026-07-29T09:00:00.001Z",
      "2026-07-29T10:00:00.000Z",
      "upcoming"
    ],
    [
      "2026-07-29T08:00:00.000Z",
      "2026-07-29T09:00:00.000Z",
      "happening"
    ],
    [
      "2026-07-29T08:00:00.000Z",
      "2026-07-29T08:59:59.999Z",
      "ended"
    ]
  ] as const)(
    "derives calendar time state for %s..%s",
    (calendarStartsAt, calendarEndsAt, expected) => {
      const source = artifact("calendar-event", {
        calendarEndsAt,
        calendarStartsAt
      });
      const result = evaluateContinuityTemporalState(source, OBSERVED_AT);
      expect(result.artifact.calendarTimeState).toBe(expected);
      expect(result.coherent).toBe(false);
      expect(
        evaluateContinuityTemporalState(result.artifact, OBSERVED_AT).coherent
      ).toBe(true);
    }
  );

  it("strips hostile derived state when its prerequisites are absent or invalid", () => {
    const noTaskDue = evaluateContinuityTemporalState(
      artifact("task", { taskDueState: "overdue", taskStatus: "open" }),
      OBSERVED_AT
    );
    expect(noTaskDue.artifact.taskDueState).toBeUndefined();
    expect(noTaskDue.field).toBe("taskDueState");

    const invalidReminderDue = evaluateContinuityTemporalState(
      artifact("reminder", {
        reminderDueAt: "not-a-date",
        reminderDueState: "due",
        reminderStatus: "pending"
      }),
      OBSERVED_AT
    );
    expect(invalidReminderDue.artifact.reminderDueAt).toBeUndefined();
    expect(invalidReminderDue.artifact.reminderDueState).toBeUndefined();

    const incompleteCalendar = evaluateContinuityTemporalState(
      artifact("calendar-event", {
        calendarStartsAt: "2026-07-29T08:00:00.000Z",
        calendarTimeState: "happening"
      }),
      OBSERVED_AT
    );
    expect(incompleteCalendar.artifact.calendarStartsAt).toBe(
      "2026-07-29T08:00:00.000Z"
    );
    expect(incompleteCalendar.artifact.calendarTimeState).toBeUndefined();
  });

  it("keeps reversed calendar source times but strips their derived claim", () => {
    const result = evaluateContinuityTemporalState(
      artifact("calendar-event", {
        calendarEndsAt: "2026-07-29T08:00:00.000Z",
        calendarStartsAt: "2026-07-29T10:00:00.000Z",
        calendarTimeState: "happening"
      }),
      OBSERVED_AT
    );
    expect(result.artifact).toMatchObject({
      calendarEndsAt: "2026-07-29T08:00:00.000Z",
      calendarStartsAt: "2026-07-29T10:00:00.000Z"
    });
    expect(result.artifact.calendarTimeState).toBeUndefined();
    expect(result.coherent).toBe(false);
  });

  it("returns untouched non-temporal artifacts and rejects a non-finite clock", () => {
    const note = artifact("note", { summary: "personal note" });
    const result = evaluateContinuityTemporalState(note, OBSERVED_AT);
    expect(result.artifact).toBe(note);
    expect(result.coherent).toBe(true);
    expect(() =>
      evaluateContinuityTemporalState(note, Number.NaN)
    ).toThrow(TypeError);
  });
});
