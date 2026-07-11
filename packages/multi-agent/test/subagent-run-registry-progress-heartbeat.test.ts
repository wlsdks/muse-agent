import { describe, expect, it } from "vitest";
import { SubAgentRunRegistry } from "../src/index.js";

/**
 * The seam this proves: agent-core's model-loop calls
 * `runner.heartbeat?.(runId)` at each stream/tool progress point of a
 * SINGLE run (a text-delta, a tool-call, once per executed tool call) —
 * never only when the run finally settles. Wired to THIS registry's
 * `heartbeat(runId)`, that turns a long-but-progressing run into a series
 * of `detectStalled` resets instead of one big silent gap, so an in-tool
 * or in-stream hang (not just an orchestrator-level worker crash) becomes
 * detectable while it's still happening.
 */
describe("SubAgentRunRegistry — per-progress heartbeat vs stall (fake clock)", () => {
  let clock = 0;
  const now = () => new Date(clock);

  function registered(timeoutMs: number): SubAgentRunRegistry {
    clock = 0;
    const registry = new SubAgentRunRegistry({ now });
    registry.register({ runId: "r", timeoutMs });
    return registry;
  }

  it("a run that keeps heartbeating on every progress tick is NEVER a false positive, even as wall time advances far past the timeout", () => {
    const registry = registered(100);
    // 10 progress ticks (each standing in for a text-delta/tool-call/tool-exec
    // heartbeat), 40ms apart — 400ms of total wall time, 4x the 100ms
    // timeout — but no SINGLE gap between heartbeats ever exceeds it.
    for (let tick = 0; tick < 10; tick++) {
      clock += 40;
      registry.heartbeat("r");
      expect(registry.detectStalled().map((rec) => rec.runId)).toEqual([]);
    }
  });

  it("a run that stops getting heartbeats past the timeout IS caught by detectStalled — the in-tool/in-stream stall this seam closes", () => {
    const registry = registered(100);
    clock += 40;
    registry.heartbeat("r"); // last real progress before the hang
    clock += 150; // 150ms of silence — past the 100ms timeout
    expect(registry.detectStalled().map((rec) => rec.runId)).toEqual(["r"]);
  });
});
