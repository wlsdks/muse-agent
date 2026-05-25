import type { AgentRunInput, AgentRunResult, AgentRuntime } from "@muse/agent-core";
import { DEFAULT_AGENT_SPECS, InMemoryAgentSpecRegistry } from "@muse/agent-specs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerMultiAgentRoutes } from "../src/multi-agent-routes.js";

// Fake runtime: echoes which spec ran so we can assert ORDER without a model.
const echoRuntime: AgentRuntime = {
  run: async (input: AgentRunInput): Promise<AgentRunResult> => ({
    response: { id: "r", model: input.model, output: "ok", raw: {} },
    runId: input.runId ?? "run"
  })
} as unknown as AgentRuntime;

async function buildApp() {
  const app = Fastify();
  registerMultiAgentRoutes(app, {
    agentRuntime: echoRuntime,
    agentSpecRegistry: new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS),
    defaultModel: "ollama/qwen3:8b"
  });
  await app.ready();
  return app;
}

describe("POST /api/multi-agent/orchestrate — default workers run Generalist→Critic (G9 route-level)", () => {
  it("with no workerIds, the seeded default workers execute in creation order", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/multi-agent/orchestrate",
        payload: { message: "anything", mode: "sequential" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { results: Array<{ workerId: string; status: string }> };
      expect(body.results.map((r) => r.workerId)).toEqual(["Generalist", "Critic"]);
      expect(body.results.every((r) => r.status === "completed")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 409 NO_AGENT_WORKERS when the registry is empty", async () => {
    const app = Fastify();
    registerMultiAgentRoutes(app, { agentRuntime: echoRuntime, agentSpecRegistry: new InMemoryAgentSpecRegistry([]), defaultModel: "m" });
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/api/multi-agent/orchestrate", payload: { message: "x" } });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { code: string }).code).toBe("NO_AGENT_WORKERS");
    } finally {
      await app.close();
    }
  });
});
