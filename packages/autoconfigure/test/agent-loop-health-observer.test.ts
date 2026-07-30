import { createLoopControlReceipt } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { createLatestAgentLoopHealthObserver } from "../src/agent-loop-health-observer.js";
import { createMuseRuntimeAssembly } from "../src/index.js";

const receipt = (
  runId: string,
  endedAt: string,
  terminal: Parameters<typeof createLoopControlReceipt>[0]["terminal"],
  verification: Parameters<typeof createLoopControlReceipt>[0]["verification"]
) => createLoopControlReceipt({
  budget: { retries: null, steps: null, tools: null, wallclockLimitMs: null },
  endedAt,
  loopKind: "react",
  runId,
  startedAt: "2026-07-30T00:00:00.000Z",
  terminal,
  verification
});

describe("latest agent loop health observer", () => {
  it("is empty before a run and keeps the newest immutable projection", () => {
    const observer = createLatestAgentLoopHealthObserver();
    const older = receipt(
      "older",
      "2026-07-30T00:00:01.000Z",
      { reason: "verification-pending", status: "held" },
      { status: "pending" }
    );
    const newer = receipt(
      "newer",
      "2026-07-30T00:00:02.000Z",
      { reason: "goal-verified", status: "completed" },
      { evidenceId: "eval:newer", status: "passed" }
    );

    expect(observer.snapshot()).toBeUndefined();
    observer.observe(newer);
    observer.observe(older);

    expect(observer.snapshot()).toMatchObject({
      endedAt: newer.endedAt,
      terminalStatus: "completed",
      verificationEvidenceId: "eval:newer",
      verificationStatus: "passed"
    });
    expect(Object.isFrozen(observer.snapshot())).toBe(true);
  });

  it("settles equal completion timestamps independently of callback arrival order", () => {
    const pending = receipt(
      "pending",
      "2026-07-30T00:00:02.000Z",
      { reason: "verification-pending", status: "held" },
      { status: "pending" }
    );
    const completed = receipt(
      "completed",
      "2026-07-30T00:00:02.000Z",
      { reason: "goal-verified", status: "completed" },
      { evidenceId: "eval:tie", status: "passed" }
    );
    const first = createLatestAgentLoopHealthObserver();
    const second = createLatestAgentLoopHealthObserver();

    first.observe(pending);
    first.observe(completed);
    second.observe(completed);
    second.observe(pending);

    expect(first.snapshot()).toEqual(second.snapshot());
  });

  it("is wired to the production assembly runtime", async () => {
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_ACTIVE_CONTEXT_ENABLED: "false",
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic"
      }
    });

    expect(assembly.observability.agentLoopHealthSnapshot()).toBeUndefined();
    const result = await assembly.agentRuntime!.run({
      messages: [{ content: "observe this run", role: "user" }],
      model: "diagnostic/smoke"
    });

    expect(assembly.observability.agentLoopHealthSnapshot()).toMatchObject({
      endedAt: result.loopControlReceipt?.endedAt,
      terminalReason: result.loopControlReceipt?.terminal.reason,
      terminalStatus: result.loopControlReceipt?.terminal.status,
      verificationStatus: result.loopControlReceipt?.verification.status
    });
  });
});
