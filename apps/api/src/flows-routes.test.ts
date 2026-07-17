import { InMemoryScheduledJobStore, type ScheduledJobInput, type ScheduledJobStore } from "@muse/scheduler";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerFlowsRoutes, type FlowsResponse } from "./flows-routes.js";

const AGENT_JOB: ScheduledJobInput = {
  agentPrompt: "오늘 일정 요약해서 보내줘",
  cronExpression: "0 9 * * *",
  enabled: true,
  jobType: "agent",
  name: "Morning brief",
  notificationChannelId: "telegram:12345"
};

describe("GET /api/flows — empty/unconfigured scheduler", () => {
  it("returns an empty list, 200, when no scheduler is wired", async () => {
    const server = Fastify();
    registerFlowsRoutes(server, { authService: undefined });
    const res = await server.inject({ method: "GET", url: "/api/flows" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as FlowsResponse;
    expect(body).toEqual({ flows: [] });
  });

  it("fails open to an empty list (still 200) when the store throws", async () => {
    const throwingStore: ScheduledJobStore = {
      delete: () => {
        throw new Error("read-only fixture");
      },
      findByName: () => undefined,
      findById: () => undefined,
      list: () => {
        throw new Error("store unavailable");
      },
      save: () => {
        throw new Error("read-only fixture");
      },
      update: () => {
        throw new Error("read-only fixture");
      },
      updateExecutionResult: () => {
        throw new Error("read-only fixture");
      }
    };
    const server = Fastify();
    registerFlowsRoutes(server, { authService: undefined, scheduler: { store: throwingStore } });
    const res = await server.inject({ method: "GET", url: "/api/flows" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ flows: [] });
  });
});

describe("GET /api/flows — populated scheduler", () => {
  it("projects each real job into a flow with trigger/action/output nodes", async () => {
    let jobIdCounter = 0;
    const jobStore = new InMemoryScheduledJobStore({
      idFactory: () => `job_${(jobIdCounter += 1).toString()}`,
      now: () => new Date("2026-07-17T00:00:00.000Z")
    });
    await jobStore.save(AGENT_JOB);

    const server = Fastify();
    registerFlowsRoutes(server, { authService: undefined, scheduler: { store: jobStore } });
    const res = await server.inject({ method: "GET", url: "/api/flows" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as FlowsResponse;
    expect(body.flows).toHaveLength(1);
    const flow = body.flows[0]!;
    expect(flow).toMatchObject({ enabled: true, name: "Morning brief", source: "scheduler" });
    expect(flow.nodes.map((n) => n.kind)).toEqual(["trigger.schedule", "action.agent", "output.notify"]);
    expect(flow.edges.length).toBeGreaterThanOrEqual(2);
  });
});
