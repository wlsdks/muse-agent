/**
 * The lifecycle-audit hook (docs/design/muse-work.md, the calendar↔reminder
 * lesson): deleting a scheduler job through `/api/scheduler/jobs/:jobId`
 * must prune that job's id out of every Work's `flowIds` — a Work must never
 * be left pointing at automation that no longer exists.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryScheduledJobStore, ScheduledJobDispatcher, ScheduledMcpToolInvoker, DynamicScheduler, type ScheduledJobInput, type ScheduledMcpToolInvoker as ScheduledMcpToolInvokerType } from "@muse/scheduler";
import { createWork, getWork, linkWorkFlow } from "@muse/stores";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerSchedulerRoutes } from "../src/scheduler-routes.js";

let root: string;
let worksFile: string;

function unusedMcpInvoker(): ScheduledMcpToolInvokerType {
  return new ScheduledMcpToolInvoker({
    connect: async () => false,
    getStatus: () => "disconnected",
    toMuseTools: () => []
  } as never);
}

const JOB_A: ScheduledJobInput = { agentPrompt: "Summarize job A", cronExpression: "0 9 * * *", enabled: true, jobType: "agent", name: "Job A" };
const JOB_B: ScheduledJobInput = { agentPrompt: "Summarize job B", cronExpression: "0 10 * * *", enabled: true, jobType: "agent", name: "Job B" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-scheduler-works-prune-"));
  worksFile = join(root, "works.json");
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function buildTestServer(worksFileOption?: string) {
  const store = new InMemoryScheduledJobStore();
  const service = new DynamicScheduler({
    dispatcher: new ScheduledJobDispatcher({
      agentExecutor: { execute: async (job) => `executed:${job.agentPrompt ?? ""}` },
      mcpInvoker: unusedMcpInvoker()
    }),
    store
  });
  const server = Fastify();
  registerSchedulerRoutes(server, {
    requireAuthenticated: () => true,
    scheduler: { service, store },
    ...(worksFileOption ? { worksFile: worksFileOption } : {})
  });
  return { server, service };
}

describe("DELETE /api/scheduler/jobs/:jobId — prunes the deleted job out of Work.flowIds", () => {
  it("removes ONLY the deleted job's id, keeping a still-real linked flow untouched", async () => {
    const { server, service } = buildTestServer(worksFile);
    const jobA = await service.create(JOB_A);
    const jobB = await service.create(JOB_B);

    const work = await createWork(worksFile, { goal: "goal", name: "Trip" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    await linkWorkFlow(worksFile, work.id, jobA.id, () => true);
    await linkWorkFlow(worksFile, work.id, jobB.id, () => true);

    const res = await server.inject({ method: "DELETE", url: `/api/scheduler/jobs/${jobA.id}` });
    expect(res.statusCode).toBe(204);

    const updated = await getWork(worksFile, work.id);
    expect(updated?.flowIds).toEqual([jobB.id]);
  });

  it("never blocks the job delete when no worksFile is wired at all", async () => {
    const { server, service } = buildTestServer(undefined);
    const jobA = await service.create(JOB_A);
    const res = await server.inject({ method: "DELETE", url: `/api/scheduler/jobs/${jobA.id}` });
    expect(res.statusCode).toBe(204);
    expect(await service.findById(jobA.id)).toBeUndefined();
  });
});
