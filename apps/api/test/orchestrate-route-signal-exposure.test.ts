import type { AgentRunInput, AgentRunResult, AgentRuntime } from "@muse/agent-core";
import { DEFAULT_AGENT_SPECS, InMemoryAgentSpecRegistry } from "@muse/agent-specs";
import type { ModelProvider, ModelResponse } from "@muse/model";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerMultiAgentRoutes } from "../src/multi-agent-routes.js";

// Two default workers DISAGREE on the same point (keyed by metadata.selectedAgentId)
// so the fan-in detector produces a structured conflict.
const DISAGREE: Record<string, string> = {
  Critic: "the project deadline is wednesday",
  Generalist: "the project deadline is tuesday"
};
const disagreeingRuntime = {
  run: async (input: AgentRunInput): Promise<AgentRunResult> => {
    const who = (input.metadata?.selectedAgentId as string | undefined) ?? "Generalist";
    return {
      response: { id: "r", model: input.model, output: DISAGREE[who] ?? "the project deadline is tuesday", raw: {} },
      runId: "run"
    };
  }
} as unknown as AgentRuntime;

const embed = async (t: string): Promise<readonly number[]> =>
  t.toLowerCase().includes("deadline") ? [1, 0] : [0, 1];

// A model provider whose verifier verdict reports a missing piece, so the route's
// verification signal is populated without a live model.
function missingProvider(verdict: string): ModelProvider {
  return {
    id: "stub",
    listModels: async () => [],
    generate: async (): Promise<ModelResponse> => ({ id: "x", model: "x", output: verdict }),
    stream: async function* () { /* unused */ }
  };
}

const payload = { message: "when is the deadline?", mode: "sequential" as const };

describe("orchestrate routes expose the structured coordination signals (not only the human ⚠ text line)", () => {
  it("POST /orchestrate returns response-level `conflicts` as a structured array when workers disagree", async () => {
    const app = Fastify();
    registerMultiAgentRoutes(app, {
      agentRuntime: disagreeingRuntime,
      agentSpecRegistry: new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS),
      defaultModel: "diagnostic",
      embed
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/api/multi-agent/orchestrate", payload });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { conflicts?: readonly string[] };
      expect(Array.isArray(body.conflicts)).toBe(true);
      expect(body.conflicts!.length).toBeGreaterThanOrEqual(1);
      expect(body.conflicts!.join(" ")).toContain("Generalist");
    } finally {
      await app.close();
    }
  });

  it("POST /orchestrate/stream emits the structured `conflicts` in the done frame (sibling parity)", async () => {
    const app = Fastify();
    registerMultiAgentRoutes(app, {
      agentRuntime: disagreeingRuntime,
      agentSpecRegistry: new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS),
      defaultModel: "diagnostic",
      embed
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/api/multi-agent/orchestrate/stream", payload });
      expect(res.statusCode).toBe(200);
      const done = res.body.split("\n").find((l) => l.startsWith("data:") && l.includes("\"conflicts\""));
      expect(done, "done frame should carry a conflicts array").toBeDefined();
      const parsed = JSON.parse(done!.slice("data:".length).trim()) as { conflicts?: readonly string[] };
      expect(Array.isArray(parsed.conflicts)).toBe(true);
      expect(parsed.conflicts!.length).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  it("POST /orchestrate returns response-level `verification` when the verifier flags a missing piece", async () => {
    const app = Fastify();
    registerMultiAgentRoutes(app, {
      agentRuntime: disagreeingRuntime,
      agentSpecRegistry: new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS),
      defaultModel: "diagnostic",
      embed,
      modelProvider: missingProvider("MISSING: the budget breakdown")
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/multi-agent/orchestrate",
        payload: { ...payload, verify: true }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { verification?: { satisfied: boolean; missing?: string } };
      expect(body.verification).toBeDefined();
      expect(body.verification!.satisfied).toBe(false);
      expect(body.verification!.missing).toBe("the budget breakdown");
    } finally {
      await app.close();
    }
  });

  it("GET /orchestrations/:runId surfaces the PERSISTED conflicts from a past disagreeing run (history twin of the live signal)", async () => {
    const app = Fastify();
    registerMultiAgentRoutes(app, {
      agentRuntime: disagreeingRuntime,
      agentSpecRegistry: new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS),
      defaultModel: "diagnostic",
      embed
    });
    await app.ready();
    try {
      const post = await app.inject({ method: "POST", url: "/api/multi-agent/orchestrate", payload });
      expect(post.statusCode).toBe(200);
      const runId = (post.json() as { runId: string }).runId;
      const get = await app.inject({ method: "GET", url: `/api/multi-agent/orchestrations/${runId}` });
      expect(get.statusCode).toBe(200);
      const body = get.json() as { conflicts?: readonly string[] };
      expect(Array.isArray(body.conflicts)).toBe(true);
      expect(body.conflicts!.length).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  it("control: a clean run (no embed, no verify) exposes neither field — no empty noise", async () => {
    const app = Fastify();
    registerMultiAgentRoutes(app, {
      agentRuntime: disagreeingRuntime,
      agentSpecRegistry: new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS),
      defaultModel: "diagnostic"
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/api/multi-agent/orchestrate", payload });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { conflicts?: unknown; verification?: unknown };
      expect(body.conflicts).toBeUndefined();
      expect(body.verification).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
