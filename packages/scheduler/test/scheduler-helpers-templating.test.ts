import type { JsonObject } from "@muse/shared";
import { describe, expect, it } from "vitest";

import { SchedulerValidationError } from "../src/scheduler-errors.js";
import {
  createScheduledJobUpdate,
  normalizeScheduledJob,
  resolveTemplateJson,
  validateJobTypeFields,
} from "../src/scheduler-helpers.js";
import { InMemoryScheduledJobStore } from "../src/scheduler-stores.js";
import type { ScheduledJob, ScheduledJobInput, ScheduledJobUpdateInput } from "../src/index.js";

const fixedNow = () => new Date("2026-03-05T14:30:00Z");
const job = (overrides: Partial<ScheduledJobInput> = {}): ScheduledJob =>
  normalizeScheduledJob(
    { name: "Daily", cronExpression: "0 9 * * *", jobType: "agent", agentPrompt: "p", timezone: "UTC", ...overrides },
    { id: "job-1", now: fixedNow },
  );

describe("validateJobTypeFields", () => {
  it("accepts an agent job that carries an agentPrompt", () => {
    expect(() => validateJobTypeFields("agent", { agentPrompt: "do the thing" } as ScheduledJobInput)).not.toThrow();
  });

  it("rejects an agent job with a missing or blank agentPrompt", () => {
    expect(() => validateJobTypeFields("agent", { agentPrompt: "   " } as ScheduledJobInput)).toThrow(SchedulerValidationError);
    expect(() => validateJobTypeFields("agent", {} as ScheduledJobInput)).toThrow(/Agent jobs require agentPrompt/);
  });

  it("accepts an mcp_tool job with both server and tool names", () => {
    expect(() =>
      validateJobTypeFields("mcp_tool", { mcpServerName: "s", toolName: "t" } as ScheduledJobInput),
    ).not.toThrow();
  });

  it("rejects an mcp_tool job missing either the server name or the tool name", () => {
    expect(() => validateJobTypeFields("mcp_tool", { toolName: "t" } as ScheduledJobInput)).toThrow(/require mcpServerName/);
    expect(() => validateJobTypeFields("mcp_tool", { mcpServerName: "s" } as ScheduledJobInput)).toThrow(/require toolName/);
  });
});

describe("resolveTemplateJson", () => {
  it("substitutes job-derived variables in string values and recurses into objects and arrays", () => {
    const resolved = resolveTemplateJson(
      { greeting: "run {{job_name}} (id {{job_id}})", nested: { who: "{{job_name}}" }, list: ["{{job_id}}", "static"] } as JsonObject,
      job(),
    );
    expect(resolved).toEqual({
      greeting: "run Daily (id job-1)",
      nested: { who: "Daily" },
      list: ["job-1", "static"],
    });
  });

  it("leaves non-string scalars untouched", () => {
    expect(resolveTemplateJson({ n: 42, ok: true, nil: null } as JsonObject, job())).toEqual({ n: 42, ok: true, nil: null });
  });

  it("expands date placeholders (resolved against the current clock, so just assert they are replaced)", () => {
    const resolved = resolveTemplateJson({ when: "at {{date}} {{time}} on {{day_of_week}}" } as JsonObject, job());
    expect(resolved.when).not.toContain("{{");
    expect(resolved.when).toMatch(/^at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} on \w+$/u);
  });
});

describe("createScheduledJobUpdate", () => {
  const existing = normalizeScheduledJob(
    {
      name: "Old",
      cronExpression: "0 9 * * *",
      jobType: "agent",
      agentPrompt: "p",
      timezone: "UTC",
      lastResult: "previous-result",
      lastStatus: "success",
    },
    { id: "keep-id", now: () => new Date("2020-01-01T00:00:00Z") },
  );

  it("only includes mutable configuration fields", () => {
    const update = createScheduledJobUpdate(
      { name: "New name", cronExpression: "0 9 * * *", jobType: "agent", agentPrompt: "p2" } as ScheduledJobInput,
      existing,
      fixedNow,
    );
    expect(update.name).toBe("New name");
    expect(update).not.toHaveProperty("id");
    expect(update).not.toHaveProperty("created_at");
    expect(update).not.toHaveProperty("last_result");
    expect(update).not.toHaveProperty("last_run_at");
    expect(update).not.toHaveProperty("last_status");
  });

  it("does not submit lifecycle fields when the input omits them", () => {
    const update = createScheduledJobUpdate(
      { name: "Old", cronExpression: "0 9 * * *", jobType: "agent", agentPrompt: "p" } as ScheduledJobInput,
      existing,
      fixedNow,
    );
    expect(update).not.toHaveProperty("last_result");
    expect(update).not.toHaveProperty("last_status");
  });

  it("does not let configuration updates overwrite execution lifecycle fields", () => {
    const update = createScheduledJobUpdate(
      {
        name: "Old",
        cronExpression: "0 9 * * *",
        jobType: "agent",
        agentPrompt: "p",
        lastResult: "stale-result",
        lastRunAt: new Date("2026-03-04T14:30:00Z"),
        lastStatus: "failed"
      } as ScheduledJobInput,
      existing,
      fixedNow,
    );
    expect(update).not.toHaveProperty("last_result");
    expect(update).not.toHaveProperty("last_run_at");
    expect(update).not.toHaveProperty("last_status");
  });

  it("preserves execution lifecycle state in the in-memory configuration path", () => {
    const store = new InMemoryScheduledJobStore({ idFactory: () => "job-1", now: fixedNow });
    const saved = store.save({ name: "Old", cronExpression: "0 9 * * *", jobType: "agent", agentPrompt: "p" });
    store.updateExecutionResult(saved.id, "success", "fresh-result");

    const staleJavaScriptInput = {
      name: "New",
      cronExpression: "0 10 * * *",
      jobType: "agent",
      agentPrompt: "updated",
      lastResult: "stale-result",
      lastRunAt: new Date("2026-03-04T14:30:00Z"),
      lastStatus: "failed"
    } as unknown as ScheduledJobUpdateInput;
    const updated = store.update(saved.id, staleJavaScriptInput);

    expect(updated).toMatchObject({
      lastResult: "fresh-result",
      lastRunAt: fixedNow(),
      lastStatus: "success",
      name: "New"
    });
  });
});
