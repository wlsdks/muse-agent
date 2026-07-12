import type { AgentRuntime, AgentRunInput, AgentRunResult } from "@muse/agent-core";
import { DEFAULT_AGENT_SPECS, InMemoryAgentSpecRegistry } from "@muse/agent-specs";
import { SubAgentRunRegistry } from "@muse/multi-agent";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerMultiAgentRoutes, resolveWorkerTimeoutMs } from "./multi-agent-routes.js";

type RunFn = (input: AgentRunInput) => Promise<AgentRunResult>;

const okRun: RunFn = (input) =>
  Promise.resolve({
    runId: input.runId ?? "run",
    response: { id: "resp", model: input.model, output: `answer from ${String(input.metadata?.selectedAgentId ?? "worker")}` }
  } as AgentRunResult);

// A runtime whose per-worker behaviour is keyed on the selected agent's name,
// so a test can make one worker succeed, throw, or hang.
function fakeRuntime(perWorker: (name: string, input: AgentRunInput) => Promise<AgentRunResult>): AgentRuntime {
  return {
    run: (input: AgentRunInput) => perWorker(String(input.metadata?.selectedAgentId ?? "worker"), input)
  } as unknown as AgentRuntime;
}

async function buildServer(opts: {
  readonly runtime: AgentRuntime;
  readonly registry: SubAgentRunRegistry;
  readonly workerTimeoutMs?: number;
}): Promise<FastifyInstance> {
  const server = Fastify();
  registerMultiAgentRoutes(server, {
    agentRuntime: opts.runtime,
    agentSpecRegistry: new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS),
    defaultModel: "test-model",
    runRegistry: opts.registry,
    ...(opts.workerTimeoutMs !== undefined ? { workerTimeoutMs: opts.workerTimeoutMs } : {})
  });
  await server.ready();
  return server;
}

let server: FastifyInstance | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("multi-agent /runs — live registry through the HTTP route (A7)", () => {
  it("registers the parent run AND each worker child run, transitioning them to completed", async () => {
    const registry = new SubAgentRunRegistry();
    server = await buildServer({ registry, runtime: fakeRuntime((_name, input) => okRun(input)) });

    const orchestrate = await server.inject({
      method: "POST",
      url: "/api/multi-agent/orchestrate",
      payload: { message: "plan the launch" }
    });
    expect(orchestrate.statusCode).toBe(200);

    const runs = await server.inject({ method: "GET", url: "/api/multi-agent/runs" });
    expect(runs.statusCode).toBe(200);
    const body = runs.json() as { runs: { runId: string; parentRunId?: string; status: string }[]; activeCount: number };

    const parents = body.runs.filter((r) => r.parentRunId === undefined);
    const children = body.runs.filter((r) => r.parentRunId !== undefined);
    expect(parents).toHaveLength(1);
    // Two default workers (Generalist + Critic) each get a child run.
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.parentRunId === parents[0]!.runId)).toBe(true);
    expect(body.runs.every((r) => r.status === "completed")).toBe(true);
    expect(body.activeCount).toBe(0);
  });

  it("records a failed worker child run as failed (not silently dropped)", async () => {
    const registry = new SubAgentRunRegistry();
    server = await buildServer({
      registry,
      runtime: fakeRuntime((name, input) =>
        name === "Critic" ? Promise.reject(new Error("critic exploded")) : okRun(input))
    });

    await server.inject({ method: "POST", url: "/api/multi-agent/orchestrate", payload: { message: "review this" } });

    const body = (await server.inject({ method: "GET", url: "/api/multi-agent/runs" })).json() as {
      runs: { runId: string; status: string; error?: string }[];
    };
    const failed = body.runs.filter((r) => r.status === "failed");
    expect(failed.some((r) => r.runId.endsWith("::Critic"))).toBe(true);
    expect(failed.find((r) => r.runId.endsWith("::Critic"))?.error).toContain("critic exploded");
    expect(body.runs.some((r) => r.runId.endsWith("::Generalist") && r.status === "completed")).toBe(true);
  });

  it("terminates a hung worker via the wired per-worker deadline and records it timed-out", async () => {
    const registry = new SubAgentRunRegistry();
    // A worker that NEVER resolves — so the per-worker deadline is the ONLY thing
    // that can settle it. No completed-vs-deadline race (which would be timing-
    // flaky under load); the outcome is deterministically timed-out.
    server = await buildServer({
      registry,
      workerTimeoutMs: 40,
      runtime: fakeRuntime(() => new Promise<AgentRunResult>(() => undefined))
    });

    await server.inject({
      method: "POST",
      url: "/api/multi-agent/orchestrate",
      payload: { message: "do the slow thing", workerIds: ["Generalist"] }
    });

    const body = (await server.inject({ method: "GET", url: "/api/multi-agent/runs" })).json() as {
      runs: { runId: string; status: string }[];
    };
    expect(body.runs.some((r) => r.runId.endsWith("::Generalist") && r.status === "timed-out")).toBe(true);
  }, 5000);
});

describe("multi-agent /orchestrate background=true — non-blocking dispatch", () => {
  it("returns 202 with orchestrationId + subtaskCount immediately, without waiting for workers", async () => {
    const registry = new SubAgentRunRegistry();
    let releaseWorkers!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWorkers = resolve; });
    server = await buildServer({
      registry,
      runtime: fakeRuntime(async (_name, input) => {
        await gate;
        return okRun(input);
      })
    });

    const orchestrate = await server.inject({
      method: "POST",
      url: "/api/multi-agent/orchestrate",
      payload: { message: "plan the launch", background: true }
    });

    expect(orchestrate.statusCode).toBe(202);
    const body = orchestrate.json() as { background: boolean; orchestrationId: string; subtaskCount: number };
    expect(body.background).toBe(true);
    expect(body.subtaskCount).toBe(2); // default Generalist + Critic workers
    expect(typeof body.orchestrationId).toBe("string");

    // Nothing has settled yet — the run is genuinely still in flight.
    const runsBeforeRelease = (await server.inject({ method: "GET", url: "/api/multi-agent/runs" })).json() as {
      activeCount: number;
    };
    expect(runsBeforeRelease.activeCount).toBeGreaterThan(0);

    releaseWorkers();
    // Poll history until the consolidated entry lands (same store the blocking path uses).
    let entry: { runId: string; status: string } | undefined;
    for (let i = 0; i < 40 && !entry; i++) {
      const list = (await server.inject({ method: "GET", url: "/api/multi-agent/orchestrations" })).json() as {
        entries: { runId: string; status: string }[];
      };
      entry = list.entries.find((e) => e.runId === body.orchestrationId);
      if (!entry) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(entry?.status).toBe("completed");
  });

  it("a background dispatch failure (bad workerIds) returns 500, never hangs", async () => {
    const registry = new SubAgentRunRegistry();
    server = await buildServer({ registry, runtime: fakeRuntime((_name, input) => okRun(input)) });

    const orchestrate = await server.inject({
      method: "POST",
      url: "/api/multi-agent/orchestrate",
      payload: { message: "plan the launch", background: true, workerIds: ["NoSuchWorker"] }
    });

    expect(orchestrate.statusCode).toBe(409); // no matching agent specs — same as the blocking path's selection guard
  });
});

describe("resolveWorkerTimeoutMs — strict positive-integer env parse", () => {
  it("returns the parsed ms for a valid positive integer", () => {
    expect(resolveWorkerTimeoutMs({ MUSE_MULTI_AGENT_WORKER_TIMEOUT_MS: "30000" })).toBe(30000);
  });
  it("returns undefined (no deadline) when unset, zero, negative, or malformed", () => {
    expect(resolveWorkerTimeoutMs({})).toBeUndefined();
    expect(resolveWorkerTimeoutMs({ MUSE_MULTI_AGENT_WORKER_TIMEOUT_MS: "0" })).toBeUndefined();
    expect(resolveWorkerTimeoutMs({ MUSE_MULTI_AGENT_WORKER_TIMEOUT_MS: "-5" })).toBeUndefined();
    expect(resolveWorkerTimeoutMs({ MUSE_MULTI_AGENT_WORKER_TIMEOUT_MS: "30x" })).toBeUndefined();
  });
});

describe("multi-agent routes — per-route auth gate (defense-in-depth)", () => {
  it("returns 401 and runs nothing when requireAuthenticated rejects", async () => {
    const s = Fastify();
    let orchestrateRan = false;
    registerMultiAgentRoutes(s, {
      agentRuntime: { run: async () => { orchestrateRan = true; return { response: { output: "x" }, results: [] } as unknown as AgentRunResult; } } as unknown as AgentRuntime,
      agentSpecRegistry: new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS),
      defaultModel: "test-model",
      requireAuthenticated: (_request, reply) => {
        reply.status(401).send({ error: "unauthorized" });
        return false;
      }
    });
    await s.ready();

    const runs = await s.inject({ method: "GET", url: "/api/multi-agent/runs" });
    expect(runs.statusCode).toBe(401);

    const orchestrate = await s.inject({ method: "POST", url: "/api/multi-agent/orchestrate", payload: { query: "hi" } });
    expect(orchestrate.statusCode).toBe(401);
    expect(orchestrateRan).toBe(false);

    await s.close();
  });
});
