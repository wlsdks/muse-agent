import { describe, expect, it } from "vitest";

import { ActiveRunTracker } from "../src/active-run-tracker.js";
import { OnExitWatcher } from "../src/on-exit-schedule.js";
import { NodeCronScheduler, ScheduledJobDispatcher } from "../src/index.js";

const invalidNonNegativeIntegers = [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY];

describe("scheduler runtime option validation", () => {
  it("rejects invalid delay and grace-period options", () => {
    for (const value of invalidNonNegativeIntegers) {
      expect(() => new NodeCronScheduler({ maxDelayMs: value })).toThrow("maxDelayMs must be a non-negative safe integer");
      expect(() => new OnExitWatcher({ killGraceMs: value })).toThrow("killGraceMs must be a non-negative safe integer");
      expect(
        () =>
          new ScheduledJobDispatcher({
            agentExecutor: { execute: async () => "done" },
            mcpInvoker: { invoke: async () => "done" },
            retryDelayMs: value
          })
      ).toThrow("retryDelayMs must be a non-negative safe integer");
    }
  });

  it("rejects invalid execution timeout defaults", () => {
    for (const defaultExecutionTimeoutMs of invalidNonNegativeIntegers) {
      expect(
        () =>
          new ScheduledJobDispatcher({
            agentExecutor: { execute: async () => "done" },
            defaultExecutionTimeoutMs,
            mcpInvoker: { invoke: async () => "done" }
          })
      ).toThrow("defaultExecutionTimeoutMs must be a positive safe integer");
    }
  });

  it("rejects invalid active-run drain timeouts", async () => {
    for (const timeoutMs of invalidNonNegativeIntegers) {
      await expect(new ActiveRunTracker().drain(timeoutMs)).rejects.toThrow(
        "timeoutMs must be a non-negative safe integer"
      );
    }
  });
});
