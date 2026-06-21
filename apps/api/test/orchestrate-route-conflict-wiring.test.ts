import type { AgentRunInput, AgentRunResult, AgentRuntime } from "@muse/agent-core";
import { DEFAULT_AGENT_SPECS, InMemoryAgentSpecRegistry } from "@muse/agent-specs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerMultiAgentRoutes } from "../src/multi-agent-routes.js";

// Two default workers DISAGREE on the same point — output keyed by which spec
// ran (createSpecWorker stamps metadata.selectedAgentId), so the fan-in sees a
// genuine cross-worker contradiction.
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

// "deadline" statements embed identically (cosine 1 → high topic sim); each
// carries one distinct day token (tuesday/wednesday → neither-subset), the exact
// shape detectPairwiseContradictions flags as a contradiction.
const embed = async (t: string): Promise<readonly number[]> =>
  t.toLowerCase().includes("deadline") ? [1, 0] : [0, 1];

function buildApp(opts: { readonly embed?: typeof embed }) {
  const app = Fastify();
  registerMultiAgentRoutes(app, {
    agentRuntime: disagreeingRuntime,
    agentSpecRegistry: new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS),
    defaultModel: "diagnostic",
    ...(opts.embed ? { embed: opts.embed } : {})
  });
  return app;
}

const MARK = "⚠ Workers disagree";
const payload = { message: "when is the deadline?", mode: "sequential" as const };

describe("orchestrate routes wire detectFanInConflicts when an embed is provided", () => {
  it("POST /orchestrate surfaces the cross-worker disagreement line in response.output", async () => {
    const app = buildApp({ embed });
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/api/multi-agent/orchestrate", payload });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { response: { output: string } }).response.output).toContain(MARK);
    } finally {
      await app.close();
    }
  });

  it("POST /orchestrate/stream surfaces the disagreement line in the done frame (sibling parity)", async () => {
    const app = buildApp({ embed });
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/api/multi-agent/orchestrate/stream", payload });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(MARK);
    } finally {
      await app.close();
    }
  });

  it("control: with NO embed wired the route stays silent — the wiring is what surfaces the conflict, not a default-on detector", async () => {
    const app = buildApp({});
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/api/multi-agent/orchestrate", payload });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { response: { output: string } }).response.output).not.toContain(MARK);
    } finally {
      await app.close();
    }
  });
});

describe("orchestrate routes ALSO wire detectFanInRedundancy when an embed is provided (fan-out step-repetition)", () => {
  // Both default workers return the SAME output → near-identical → redundant (and NOT a
  // conflict: identical token sets fail the neither-subset gate).
  const identicalRuntime = {
    run: async (input: AgentRunInput): Promise<AgentRunResult> => ({
      response: { id: "r", model: input.model, output: "the project deadline is tuesday", raw: {} },
      runId: "run"
    })
  } as unknown as AgentRuntime;

  function appWith(embedFn?: typeof embed) {
    const app = Fastify();
    registerMultiAgentRoutes(app, {
      agentRuntime: identicalRuntime,
      agentSpecRegistry: new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS),
      defaultModel: "diagnostic",
      ...(embedFn ? { embed: embedFn } : {})
    });
    return app;
  }

  it("POST /orchestrate surfaces the redundancy advisory in response.output when workers duplicate work", async () => {
    const app = appWith(embed);
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/api/multi-agent/orchestrate", payload });
      expect(res.statusCode).toBe(200);
      const output = (res.json() as { response: { output: string } }).response.output;
      expect(output).toContain("ℹ Workers produced near-identical answers");
      expect(output).not.toContain("⚠ Workers disagree"); // identical ≠ contradiction
    } finally {
      await app.close();
    }
  });

  it("control: with NO embed wired the route stays silent (no advisory)", async () => {
    const app = appWith();
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/api/multi-agent/orchestrate", payload });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { response: { output: string } }).response.output).not.toContain("near-identical");
    } finally {
      await app.close();
    }
  });
});
