import { describe, expect, it } from "vitest";

import { normalizeLocalTaskMutationOutcome } from "../src/task-mutation-outcome.js";

describe("normalizeLocalTaskMutationOutcome", () => {
  it.each([
    ["muse.tasks.add", "task"],
    ["muse.tasks.complete", "task"],
    ["muse.followup.cancel", "followup"],
    ["muse.followup.snooze", "followup"]
  ] as const)("marks a proven %s mutation completed", (tool, proofField) => {
    const output = { [proofField]: { id: "local-1" } };
    expect(normalizeLocalTaskMutationOutcome(tool, output)).toEqual({
      completed: true,
      result: output
    });
  });

  it.each([
    ["ok", { ok: false, task: { id: "task-1" } }],
    ["success", { success: false, task: { id: "task-1" } }],
    ["sent", { sent: false, task: { id: "task-1" } }],
    ["performed", { performed: false, task: { id: "task-1" } }],
    ["completed", { completed: false, task: { id: "task-1" } }],
    ["error", { error: "task write failed", task: { id: "task-1" } }],
    ["blocked", { blocked: true, task: { id: "task-1" } }]
  ])("does not add success when %s is a negative marker", (_marker, output) => {
    expect(normalizeLocalTaskMutationOutcome("muse.tasks.add", output)).toBe(output);
  });

  it("does not add success when the tool-specific mutation proof is absent", () => {
    const output = { task: { id: "task-1" } };
    expect(normalizeLocalTaskMutationOutcome("muse.followup.cancel", output)).toBe(output);
  });
});
