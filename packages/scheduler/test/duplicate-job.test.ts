import { describe, expect, it } from "vitest";

import { buildDuplicateJobInput } from "../src/duplicate-job.js";

import type { ScheduledJob } from "../src/index.js";

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    agentPrompt: "summarize my day",
    cronExpression: "0 9 * * *",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    enabled: true,
    id: "job_source",
    jobType: "agent",
    lastResult: "prior run output",
    lastRunAt: new Date("2026-07-01T00:00:00.000Z"),
    lastStatus: "success",
    maxRetryCount: 3,
    name: "Morning brief",
    notificationChannelId: "telegram:555",
    retryOnFailure: true,
    tags: ["daily", "brief"],
    timezone: "Asia/Seoul",
    toolArguments: {},
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    webhookUrl: "https://hook.example/x",
    ...overrides
  };
}

describe("buildDuplicateJobInput", () => {
  it("copies every schedule/action field of an agent job", () => {
    const input = buildDuplicateJobInput(job(), { nameSuffix: " (copy)" });
    expect(input.cronExpression).toBe("0 9 * * *");
    expect(input.timezone).toBe("Asia/Seoul");
    expect(input.jobType).toBe("agent");
    expect(input.agentPrompt).toBe("summarize my day");
    expect(input.notificationChannelId).toBe("telegram:555");
    expect(input.webhookUrl).toBe("https://hook.example/x");
    expect(input.retryOnFailure).toBe(true);
    expect(input.maxRetryCount).toBe(3);
    expect(input.tags).toEqual(["daily", "brief"]);
  });

  it("copies webhookUrl — a job delivering to a webhook (no notify channel) must still deliver after copy", () => {
    const input = buildDuplicateJobInput(
      job({ notificationChannelId: undefined, webhookUrl: "https://hook.example/deliver" }),
      { nameSuffix: " (copy)" }
    );
    expect(input.webhookUrl).toBe("https://hook.example/deliver");
    expect(input.notificationChannelId ?? null).toBeNull();
  });

  it("copies the mcp_tool action fields for a tool job", () => {
    const input = buildDuplicateJobInput(
      job({
        jobType: "mcp_tool",
        agentPrompt: undefined,
        mcpServerName: "muse.time",
        toolName: "now",
        toolArguments: { tz: "UTC" }
      }),
      { nameSuffix: " (copy)" }
    );
    expect(input.jobType).toBe("mcp_tool");
    expect(input.mcpServerName).toBe("muse.time");
    expect(input.toolName).toBe("now");
    expect(input.toolArguments).toEqual({ tz: "UTC" });
  });

  it("appends the name suffix so the copy is distinguishable", () => {
    expect(buildDuplicateJobInput(job(), { nameSuffix: " (copy)" }).name).toBe("Morning brief (copy)");
  });

  it("creates the copy DISABLED — a duplicated schedule must not silently fire", () => {
    expect(buildDuplicateJobInput(job({ enabled: true }), { nameSuffix: " (copy)" }).enabled).toBe(false);
  });

  it("carries no id — the copy is a new job, not an alias", () => {
    expect(buildDuplicateJobInput(job(), { nameSuffix: " (copy)" }).id).toBeUndefined();
  });

  it("drops the source's execution lifecycle (a fresh copy has no history)", () => {
    const input = buildDuplicateJobInput(job(), { nameSuffix: " (copy)" }) as Record<string, unknown>;
    expect(input.lastRunAt ?? null).toBeNull();
    expect(input.lastStatus ?? null).toBeNull();
    expect(input.lastResult ?? null).toBeNull();
    expect(input.createdAt ?? null).toBeNull();
  });

  it("does not alias the source's tags array (a later push must not mutate the source)", () => {
    const source = job();
    const input = buildDuplicateJobInput(source, { nameSuffix: " (copy)" });
    expect(input.tags).not.toBe(source.tags);
  });
});

it("NEVER copies the inbound webhook trigger token — a duplicate must mint its own or stay tokenless", () => {
  const input = buildDuplicateJobInput(job({ webhookTriggerToken: "tok_secret" } as never), { nameSuffix: " (copy)" });
  expect((input as { webhookTriggerToken?: string }).webhookTriggerToken).toBeUndefined();
});
