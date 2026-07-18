import { describe, expect, it } from "vitest";

import { projectFlow, projectFlows } from "./flow-projection.js";

import type { ScheduledJob } from "@muse/scheduler";

const NOW = new Date("2026-07-17T00:00:00.000Z");

const BASE_JOB: ScheduledJob = {
  cronExpression: "0 9 * * *",
  createdAt: NOW,
  enabled: true,
  id: "job_1",
  jobType: "agent",
  maxRetryCount: 3,
  name: "Morning brief",
  retryOnFailure: false,
  tags: [],
  timezone: "UTC",
  toolArguments: {},
  updatedAt: NOW
};

describe("projectFlow — trigger node", () => {
  it("projects the real cron/timezone and the computed next run", () => {
    const flow = projectFlow(BASE_JOB, NOW);
    const trigger = flow.nodes[0]!;
    expect(trigger.kind).toBe("trigger.schedule");
    expect(trigger.meta.cronExpression).toBe("0 9 * * *");
    expect(trigger.meta.timezone).toBe("UTC");
    expect(trigger.meta.nextRunAtIso).toBe("2026-07-17T09:00:00.000Z");
    expect(flow.nextRunAtIso).toBe("2026-07-17T09:00:00.000Z");
  });

  it("falls back to a null next-run when the persisted cron can't be evaluated (fail-open, not a throw)", () => {
    const flow = projectFlow({ ...BASE_JOB, cronExpression: "not a cron" }, NOW);
    expect(flow.nodes[0]!.meta.nextRunAtIso).toBeNull();
    expect(flow.nextRunAtIso).toBeNull();
  });

  it("reports NO next-run for a disabled flow (it will not fire — showing a next-run would be dishonest), while keeping the cron/timezone visible", () => {
    const flow = projectFlow({ ...BASE_JOB, enabled: false }, NOW);
    expect(flow.enabled).toBe(false);
    expect(flow.nextRunAtIso).toBeNull();
    expect(flow.nodes[0]!.meta.nextRunAtIso).toBeNull();
    // the schedule config is still shown while paused
    expect(flow.nodes[0]!.meta.cronExpression).toBe("0 9 * * *");
    expect(flow.nodes[0]!.meta.timezone).toBe("UTC");
  });
});

describe("projectFlow — action node variants", () => {
  it("projects an agent job with a truncated prompt + model + maxToolCalls", () => {
    const job: ScheduledJob = {
      ...BASE_JOB,
      agentMaxToolCalls: 5,
      agentModel: "ollama/gemma4:12b",
      agentPrompt: "a".repeat(250)
    };
    const flow = projectFlow(job, NOW);
    const action = flow.nodes[1]!;
    expect(action.kind).toBe("action.agent");
    expect(action.meta.model).toBe("ollama/gemma4:12b");
    expect(action.meta.maxToolCalls).toBe(5);
    expect(typeof action.meta.prompt).toBe("string");
    expect((action.meta.prompt as string).length).toBe(200);
    expect((action.meta.prompt as string).endsWith("…")).toBe(true);
  });

  it("projects a tool job with server + tool name, never the agent shape", () => {
    const job: ScheduledJob = {
      ...BASE_JOB,
      jobType: "mcp_tool",
      mcpServerName: "notion",
      toolName: "create_page"
    };
    const flow = projectFlow(job, NOW);
    const action = flow.nodes[1]!;
    expect(action.kind).toBe("action.tool");
    expect(action.meta).toEqual({ server: "notion", tool: "create_page" });
  });

  it("NEVER projects toolArguments, even when they carry a sensitive value — the Builder's tool-flow arg edit surface must not leak them via /api/flows", () => {
    const job: ScheduledJob = {
      ...BASE_JOB,
      jobType: "mcp_tool",
      mcpServerName: "notion",
      toolArguments: { apiKey: "SECRET_TOKEN_123", pageId: "abc" },
      toolName: "create_page"
    };
    const flow = projectFlow(job, NOW);
    const action = flow.nodes[1]!;
    expect(Object.keys(action.meta)).toEqual(["server", "tool"]);
    expect(JSON.stringify(action.meta)).not.toContain("SECRET_TOKEN_123");
  });
});

describe("projectFlow — output node variants", () => {
  it("projects a notify output from notificationChannelId", () => {
    const flow = projectFlow({ ...BASE_JOB, notificationChannelId: "telegram:12345" }, NOW);
    const output = flow.nodes[2]!;
    expect(output.kind).toBe("output.notify");
    expect(output.meta).toEqual({ channelId: "telegram:12345" });
  });

  it("projects a webhook output with ONLY the host — query string stripped (may carry a secret)", () => {
    const flow = projectFlow({ ...BASE_JOB, webhookUrl: "https://hooks.example.com/x?token=SECRET" }, NOW);
    const output = flow.nodes[2]!;
    expect(output.kind).toBe("output.webhook");
    expect(output.meta.url).toBe("hooks.example.com");
    expect(JSON.stringify(output.meta)).not.toContain("SECRET");
  });

  it("falls back to a record output when neither notify nor webhook is configured", () => {
    const flow = projectFlow(BASE_JOB, NOW);
    const output = flow.nodes[2]!;
    expect(output.kind).toBe("output.record");
  });

  it("prefers notify over webhook when both happen to be set", () => {
    const flow = projectFlow(
      { ...BASE_JOB, notificationChannelId: "telegram:1", webhookUrl: "https://hooks.example.com/x" },
      NOW
    );
    expect(flow.nodes[2]!.kind).toBe("output.notify");
  });
});

describe("projectFlow — retry loop edge (the visible LOOP concept)", () => {
  it("adds a self-edge on the action node labeled with the real retry count when retryOnFailure is true", () => {
    const flow = projectFlow({ ...BASE_JOB, maxRetryCount: 4, retryOnFailure: true }, NOW);
    const loopEdge = flow.edges.find((edge) => edge.loop === true);
    expect(loopEdge).toBeDefined();
    expect(loopEdge!.from).toBe(loopEdge!.to);
    expect(loopEdge!.from).toBe(flow.nodes[1]!.id);
    expect(loopEdge!.label).toBe("실패 시 재시도 ×4");
  });

  it("has NO loop edge when retryOnFailure is false — mutation-RED case: removing the retry", () => {
    const flow = projectFlow({ ...BASE_JOB, retryOnFailure: false }, NOW);
    expect(flow.edges.some((edge) => edge.loop === true)).toBe(false);
    expect(flow.edges).toHaveLength(2);
  });
});

describe("projectFlow — linear edges + disabled job", () => {
  it("always wires trigger -> action -> output linearly", () => {
    const flow = projectFlow(BASE_JOB, NOW);
    const [trigger, action, output] = flow.nodes;
    expect(flow.edges[0]).toMatchObject({ from: trigger!.id, to: action!.id });
    expect(flow.edges[1]).toMatchObject({ from: action!.id, to: output!.id });
  });

  it("projects a disabled job with enabled: false, unchanged node/edge shape", () => {
    const flow = projectFlow({ ...BASE_JOB, enabled: false }, NOW);
    expect(flow.enabled).toBe(false);
    expect(flow.nodes).toHaveLength(3);
  });
});

describe("projectFlows — sort order", () => {
  it("sorts enabled jobs first, then by soonest next-run", () => {
    const soon: ScheduledJob = { ...BASE_JOB, cronExpression: "0 1 * * *", id: "soon" };
    const later: ScheduledJob = { ...BASE_JOB, cronExpression: "0 23 * * *", id: "later" };
    const disabled: ScheduledJob = { ...BASE_JOB, enabled: false, id: "disabled" };
    const flows = projectFlows([later, disabled, soon], NOW);
    expect(flows.map((f) => f.id)).toEqual(["soon", "later", "disabled"]);
  });
});
