import { describe, expect, it } from "vitest";

import {
  createLoopControlReceipt,
  parseLoopControlReceipt,
  projectLoopControlReceiptHealth,
  settleLoopControlReceipt
} from "../src/loop-control-receipt.js";

const base = () =>
  createLoopControlReceipt({
    budget: {
      retries: { limit: 3, used: 1 },
      steps: { limit: 8, used: 4 },
      tools: { limit: 5, used: 2 },
      wallclockLimitMs: 10_000
    },
    endedAt: "2026-07-30T00:00:03.000Z",
    loopKind: "react",
    runId: "run-1",
    startedAt: "2026-07-30T00:00:00.000Z",
    terminal: { reason: "goal-verified", status: "completed" },
    verification: { evidenceId: "eval:1", status: "passed" }
  });

describe("LoopControlReceipt", () => {
  it("creates a deterministic content-bound terminal receipt", () => {
    const receipt = base();

    expect(receipt.receiptId).toMatch(/^loop-control:[a-f0-9]{64}$/);
    expect(receipt.budget.wallclock).toEqual({ elapsedMs: 3_000, exhausted: false, limitMs: 10_000 });
    expect(createLoopControlReceipt({
      budget: { retries: { limit: 3, used: 1 }, steps: { limit: 8, used: 4 }, tools: { limit: 5, used: 2 }, wallclockLimitMs: 10_000 },
      endedAt: receipt.endedAt,
      loopKind: receipt.loopKind,
      runId: receipt.runId,
      startedAt: receipt.startedAt,
      terminal: receipt.terminal,
      verification: receipt.verification
    })).toEqual(receipt);
  });

  it("round-trips only an exact, untampered receipt", () => {
    const receipt = base();
    expect(parseLoopControlReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(() => parseLoopControlReceipt({ ...receipt, runId: "tampered" })).toThrow(/receiptId/);
    expect(() => parseLoopControlReceipt({ ...receipt, extra: true })).toThrow(/exactly/);
  });

  it("projects supervisor health only from a validated content-bound receipt", () => {
    const receipt = base();

    const projected = projectLoopControlReceiptHealth(receipt);
    expect(projected).toEqual({
      endedAt: "2026-07-30T00:00:03.000Z",
      terminalReason: "goal-verified",
      terminalStatus: "completed",
      verificationEvidenceId: "eval:1",
      verificationStatus: "passed"
    });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(projectLoopControlReceiptHealth({ ...receipt, runId: "tampered" })).toBeUndefined();
  });

  it("does not execute hostile accessors while projecting health", () => {
    const receipt = base();
    let getterCalls = 0;
    const hostile = { ...receipt } as Record<string, unknown>;
    Object.defineProperty(hostile, "verification", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return receipt.verification;
      }
    });

    expect(projectLoopControlReceiptHealth(hostile)).toBeUndefined();
    expect(getterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxy = new Proxy(receipt, {
      getPrototypeOf: () => {
        proxyTrapCalls += 1;
        return Object.prototype;
      }
    });
    expect(projectLoopControlReceiptHealth(proxy)).toBeUndefined();
    expect(proxyTrapCalls).toBe(0);
  });

  it("rejects completion before verification reaches a terminal verdict", () => {
    expect(() =>
      createLoopControlReceipt({
        budget: { retries: null, steps: null, tools: null, wallclockLimitMs: null },
        endedAt: "2026-07-30T00:00:03.000Z",
        loopKind: "react",
        runId: "run-1",
        startedAt: "2026-07-30T00:00:00.000Z",
        terminal: { reason: "goal-verified", status: "completed" },
        verification: { status: "pending" }
      })
    ).toThrow(/completed loops require/);
  });

  it("requires exhausted evidence for budget and deadline terminal reasons", () => {
    expect(() =>
      createLoopControlReceipt({
        budget: { retries: { limit: 3, used: 2 }, steps: null, tools: null, wallclockLimitMs: null },
        endedAt: "2026-07-30T00:00:03.000Z",
        loopKind: "react",
        runId: "run-1",
        startedAt: "2026-07-30T00:00:00.000Z",
        terminal: { reason: "budget-exhausted", status: "failed" },
        verification: { status: "not-required" }
      })
    ).toThrow(/requires an exhausted/);

    expect(() =>
      createLoopControlReceipt({
        budget: { retries: null, steps: null, tools: null, wallclockLimitMs: 4_000 },
        endedAt: "2026-07-30T00:00:03.000Z",
        loopKind: "react",
        runId: "run-1",
        startedAt: "2026-07-30T00:00:00.000Z",
        terminal: { reason: "deadline-exceeded", status: "failed" },
        verification: { status: "not-required" }
      })
    ).toThrow(/requires an exhausted wallclock/);
  });

  it("rejects non-monotonic time and malformed budget snapshots", () => {
    expect(() =>
      createLoopControlReceipt({
        budget: { retries: null, steps: null, tools: null, wallclockLimitMs: null },
        endedAt: "2026-07-29T23:59:59.000Z"
        ,
        loopKind: "react",
        runId: "run-1",
        startedAt: "2026-07-30T00:00:00.000Z",
        terminal: { reason: "goal-verified", status: "completed" },
        verification: { status: "not-required" }
      })
    ).toThrow(/must not precede/);

    const receipt = base();
    expect(() =>
      parseLoopControlReceipt({
        ...receipt,
        budget: { ...receipt.budget, tools: { exhausted: true, limit: 5, used: 2 } }
      })
    ).toThrow(/inconsistent/);
  });

  it("copies and freezes caller-owned objects so the content binding cannot go stale", () => {
    const terminal = { reason: "goal-verified", status: "completed" } as const;
    const verification = { evidenceId: "eval:1", status: "passed" } as const;
    const receipt = createLoopControlReceipt({
      budget: { retries: null, steps: null, tools: null, wallclockLimitMs: null },
      endedAt: "2026-07-30T00:00:03.000Z",
      loopKind: "react",
      runId: "run-1",
      startedAt: "2026-07-30T00:00:00.000Z",
      terminal,
      verification
    });
    const originalId = receipt.receiptId;

    (terminal as { reason: string }).reason = "tampered";
    (verification as { evidenceId: string }).evidenceId = "tampered";

    expect(receipt.terminal.reason).toBe("goal-verified");
    expect(receipt.verification).toEqual({ evidenceId: "eval:1", status: "passed" });
    expect(receipt.receiptId).toBe(originalId);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("rejects accessors, symbols, non-enumerable keys, and unsafe unknown fields", () => {
    const receipt = base();
    const accessor = { ...receipt } as Record<string, unknown>;
    Object.defineProperty(accessor, "runId", { enumerable: true, get: () => "run-1" });
    expect(() => parseLoopControlReceipt(accessor)).toThrow(/data property/);

    let getterCalls = 0;
    const getterVerification = {} as Record<string, unknown>;
    Object.defineProperty(getterVerification, "status", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "pending";
      }
    });
    expect(() => parseLoopControlReceipt({ ...receipt, verification: getterVerification })).toThrow(/data property/);
    expect(getterCalls).toBe(0);

    const hidden = { ...receipt };
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
    expect(() => parseLoopControlReceipt(hidden)).toThrow(/exactly/);

    expect(() => parseLoopControlReceipt({ ...receipt, [Symbol("hidden")]: true })).toThrow(/symbol/);
    expect(() => parseLoopControlReceipt({ ...receipt, runId: 42 })).toThrow(/runId must be a string/);
    expect(() => parseLoopControlReceipt({ ...receipt, terminal: { reason: "goal-verified", status: 42 } })).toThrow(
      /terminal status/
    );
  });

  it("settles only a pending receipt with exact passed or failed evidence", () => {
    const pending = createLoopControlReceipt({
      budget: { retries: null, steps: null, tools: null, wallclockLimitMs: null },
      endedAt: "2026-07-30T00:00:03.000Z",
      loopKind: "react",
      runId: "run-settle",
      startedAt: "2026-07-30T00:00:00.000Z",
      terminal: { reason: "verification-pending", status: "held" },
      verification: { status: "pending" }
    });

    expect(settleLoopControlReceipt(pending, { evidenceId: "eval:pass", status: "passed" }).terminal)
      .toEqual({ reason: "goal-verified", status: "completed" });
    expect(settleLoopControlReceipt(pending, { evidenceId: "eval:fail", status: "failed" }).terminal)
      .toEqual({ reason: "verification-failed", status: "failed" });
    expect(() => settleLoopControlReceipt(base(), { evidenceId: "eval:pass", status: "passed" })).toThrow(
      /only a verification-pending/
    );
    expect(() => settleLoopControlReceipt(pending, { status: "pending" })).toThrow(/passed or failed/);
  });
});
