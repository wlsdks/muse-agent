import { DiagnosticModelProvider } from "@muse/model";
import { describe, expect, it } from "vitest";

import { AgentRuntime } from "../src/agent-runtime.js";

// The registry that consumes liveness beats (SubAgentRunRegistry, apps/api)
// is constructed AFTER the shared AgentRuntime, so the heartbeat must be
// late-bindable — a constructor-only seam leaves the live server without
// stall detection (the D3-S2 gap). These tests pin the post-construction
// seam at the runtime level; per-event emission counts are pinned by
// model-loop-heartbeat.test.ts.

describe("AgentRuntime.setHeartbeat (late-bound liveness seam)", () => {
  it("beats bound AFTER construction flow on a streaming run with the run's runId", async () => {
    const runtime = new AgentRuntime({ modelProvider: new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" }) });
    const beats: string[] = [];
    runtime.setHeartbeat((runId) => beats.push(runId));

    const events = runtime.stream({
      messages: [{ content: "hello", role: "user" }],
      metadata: { runId: "late-bound-run", sessionId: "s", userId: "u" },
      model: "diagnostic/smoke"
    });
    for await (const _event of events) {
      /* drain the stream so the loop actually progresses */
    }

    expect(beats.length).toBeGreaterThan(0);
    expect(new Set(beats).size).toBe(1);
  });

  it("a run without a bound heartbeat still completes (seam is optional)", async () => {
    const runtime = new AgentRuntime({ modelProvider: new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" }) });
    const result = await runtime.run({
      messages: [{ content: "hello", role: "user" }],
      metadata: { sessionId: "s", userId: "u" },
      model: "diagnostic/smoke"
    });
    expect(result.response).toBeDefined();
  });
});
