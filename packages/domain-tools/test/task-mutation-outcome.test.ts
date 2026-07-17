import { describe, expect, it } from "vitest";

import { normalizeLocalTaskMutationOutcome } from "../src/task-mutation-outcome.js";

describe("normalizeLocalTaskMutationOutcome", () => {
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
});
