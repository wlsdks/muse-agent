import { describe, expect, it } from "vitest";

import { GuardBlockedError, OutputGuardBlockedError } from "../src/errors.js";
import { applyOutputGuards, applyResponseFilters, evaluateGuards } from "../src/guard-pipeline.js";
import type {
  AgentRunContext,
  GuardStage,
  OutputGuardStage,
  ResponseFilterStage
} from "../src/types.js";

const ctx: AgentRunContext = {
  input: { messages: [{ content: "hi", role: "user" }], model: "test-model" },
  runId: "run-pipeline",
  startedAt: new Date("2026-05-20T00:00:00.000Z")
};

// The pipeline only calls startSpan().setError/setAttribute/end and
// a couple of metrics recorders — a no-op surface is the honest stub.
const span = { end: () => undefined, setAttribute: () => undefined, setError: () => undefined };
const tracer = { startSpan: () => span } as unknown as Parameters<typeof evaluateGuards>[2];
const metrics = {
  recordGuardRejection: () => undefined,
  recordOutputGuardAction: () => undefined
} as unknown as Parameters<typeof evaluateGuards>[3];

function resp(output: string) {
  return { output } as unknown as Parameters<typeof applyResponseFilters>[1];
}

describe("evaluateGuards — fail-close", () => {
  it("a guard that THROWS blocks the run (GUARD_ERROR) and short-circuits later guards", async () => {
    const calls: string[] = [];
    const guards: GuardStage[] = [
      { evaluate: () => { calls.push("a"); throw new Error("guard boom"); }, id: "a" },
      { evaluate: () => { calls.push("b"); return { allowed: true }; }, id: "b" }
    ];
    await expect(evaluateGuards(ctx, guards, tracer, metrics, undefined)).rejects.toMatchObject({
      code: "GUARD_ERROR"
    });
    await expect(evaluateGuards(ctx, [guards[0]!], tracer, metrics, undefined)).rejects.toBeInstanceOf(
      GuardBlockedError
    );
    expect(calls).not.toContain("b"); // second guard never reached after the throw
  });

  it("a `{allowed:false}` decision blocks with the decision's code; allowed guards pass through in order", async () => {
    const seen: string[] = [];
    const guards: GuardStage[] = [
      { evaluate: () => { seen.push("ok"); return { allowed: true }; }, id: "ok" },
      { evaluate: () => ({ allowed: false, code: "POLICY_X", reason: "nope" }), id: "deny" },
      { evaluate: () => { seen.push("never"); return { allowed: true }; }, id: "never" }
    ];
    await expect(evaluateGuards(ctx, guards, tracer, metrics, undefined)).rejects.toMatchObject({
      code: "POLICY_X"
    });
    expect(seen).toEqual(["ok"]); // ran the first, blocked at the second, never reached the third

    await expect(
      evaluateGuards(ctx, [guards[0]!], tracer, metrics, undefined)
    ).resolves.toBeUndefined(); // all-allowed → no throw
  });
});

describe("applyResponseFilters — fail-open", () => {
  it("a throwing filter leaves the response UNCHANGED and does not abort the chain", async () => {
    const filters: ResponseFilterStage[] = [
      { apply: () => { throw new Error("filter boom"); }, id: "boom" },
      { apply: (r) => ({ ...r, output: `${(r as { output: string }).output}!` }), id: "bang" }
    ];
    const out = (await applyResponseFilters(ctx, resp("base"), filters, tracer)) as { output: string };
    // boom is swallowed (fail-open), bang still runs on the unchanged value.
    expect(out.output).toBe("base!");
  });

  it("non-throwing filters chain: filter 2 sees filter 1's output", async () => {
    const filters: ResponseFilterStage[] = [
      { apply: (r) => ({ ...r, output: `${(r as { output: string }).output}-1` }), id: "f1" },
      { apply: (r) => ({ ...r, output: `${(r as { output: string }).output}-2` }), id: "f2" }
    ];
    const out = (await applyResponseFilters(ctx, resp("x"), filters, tracer)) as { output: string };
    expect(out.output).toBe("x-1-2");
  });
});

describe("applyOutputGuards — fail-close + decisions", () => {
  it("a guard that THROWS blocks (OUTPUT_GUARD_ERROR)", async () => {
    const guards: OutputGuardStage[] = [
      { check: () => { throw new Error("oguard boom"); }, id: "boom" }
    ];
    await expect(applyOutputGuards(ctx, resp("o"), guards, tracer, metrics)).rejects.toMatchObject({
      code: "OUTPUT_GUARD_ERROR"
    });
    await expect(
      applyOutputGuards(ctx, resp("o"), guards, tracer, metrics)
    ).rejects.toBeInstanceOf(OutputGuardBlockedError);
  });

  it("`reject` blocks with the decision code; `modify` chains the modified output into the next guard; `allow` passes through", async () => {
    await expect(
      applyOutputGuards(
        ctx,
        resp("o"),
        [{ check: () => ({ action: "reject", code: "BANNED", reason: "no" }), id: "r" }],
        tracer,
        metrics
      )
    ).rejects.toMatchObject({ code: "BANNED" });

    let secondSaw = "";
    const guarded = (await applyOutputGuards(
      ctx,
      resp("orig"),
      [
        { check: () => ({ action: "modify", content: "REDACTED", reason: "pii" }), id: "m" },
        { check: (content) => { secondSaw = content; return { action: "allow" }; }, id: "a" }
      ],
      tracer,
      metrics
    )) as { output: string };
    expect(secondSaw).toBe("REDACTED"); // second guard sees the modified content
    expect(guarded.output).toBe("REDACTED");

    const passthrough = (await applyOutputGuards(
      ctx,
      resp("keep"),
      [{ check: () => ({ action: "allow" }), id: "a" }],
      tracer,
      metrics
    )) as { output: string };
    expect(passthrough.output).toBe("keep");
  });
});
