import { describe, expect, it } from "vitest";

import {
  beginResidentDaemonRestartState,
  decideResidentDaemonRestartAdmission,
  parseResidentDaemonRestartStateReceipt,
  recordResidentDaemonRestartFailure,
  recordResidentDaemonRestartSuccess,
  resetResidentDaemonRestartState,
  type ResidentDaemonRestartPolicy
} from "./resident-daemon-restart-state.js";

const POLICY: ResidentDaemonRestartPolicy = {
  baseDelayMs: 1_000,
  failureThreshold: 3,
  failureWindowMs: 60_000,
  maxDelayMs: 4_000,
  openCooldownMs: 30_000
};
const START = new Date("2026-07-25T18:00:00.000Z");

describe("resident daemon restart state machine", () => {
  it("applies bounded exponential delay and opens at the failure threshold", () => {
    let state = beginResidentDaemonRestartState(POLICY, START);
    state = recordResidentDaemonRestartFailure(state, { at: START, failureSequence: 10 });
    expect(decideResidentDaemonRestartAdmission(state, {
      generation: "generation_0001",
      now: START
    }).admission).toMatchObject({ delayMs: 1_000, state: "delay" });

    state = recordResidentDaemonRestartFailure(state, {
      at: new Date(START.getTime() + 1_000),
      failureSequence: 11
    });
    expect(state).toMatchObject({ failureCount: 2, state: "closed" });
    expect(decideResidentDaemonRestartAdmission(state, {
      generation: "generation_0002",
      now: new Date(START.getTime() + 1_000)
    }).admission).toMatchObject({ delayMs: 2_000, state: "delay" });

    state = recordResidentDaemonRestartFailure(state, {
      at: new Date(START.getTime() + 2_000),
      failureSequence: 12
    });
    expect(state).toMatchObject({ failureCount: 3, state: "open" });
    expect(decideResidentDaemonRestartAdmission(state, {
      generation: "generation_0003",
      now: new Date(START.getTime() + 2_000)
    }).admission).toMatchObject({ delayMs: 30_000, state: "open" });
  });

  it("admits exactly one half-open generation and closes only after its success", () => {
    let state = beginResidentDaemonRestartState({ ...POLICY, failureThreshold: 1 }, START);
    state = recordResidentDaemonRestartFailure(state, { at: START, failureSequence: 20 });
    const probe = decideResidentDaemonRestartAdmission(state, {
      generation: "probe_generation_01",
      now: new Date(START.getTime() + POLICY.openCooldownMs)
    });
    expect(probe.admission).toEqual({ state: "half-open-probe" });
    expect(decideResidentDaemonRestartAdmission(probe.receipt, {
      generation: "other_generation_02",
      now: new Date(START.getTime() + POLICY.openCooldownMs)
    }).admission).toMatchObject({ delayMs: POLICY.openCooldownMs, state: "open" });
    expect(() => recordResidentDaemonRestartSuccess(probe.receipt, {
      generation: "other_generation_02",
      now: new Date(START.getTime() + POLICY.openCooldownMs)
    })).toThrow("probe generation mismatch");
    const recovered = recordResidentDaemonRestartSuccess(probe.receipt, {
      generation: "probe_generation_01",
      now: new Date(START.getTime() + POLICY.openCooldownMs)
    });
    expect(recovered).toMatchObject({
      failureCount: 0,
      lastFailureSequence: 20,
      state: "closed"
    });
    expect(recordResidentDaemonRestartFailure(recovered, {
      at: new Date(START.getTime() + POLICY.openCooldownMs + 1),
      failureSequence: 20
    })).toBe(recovered);
  });

  it("reopens after a failed half-open probe and ignores stale failure sequences", () => {
    let state = beginResidentDaemonRestartState({ ...POLICY, failureThreshold: 1 }, START);
    state = recordResidentDaemonRestartFailure(state, { at: START, failureSequence: 30 });
    state = decideResidentDaemonRestartAdmission(state, {
      generation: "probe_generation_01",
      now: new Date(START.getTime() + POLICY.openCooldownMs)
    }).receipt;
    const reopened = recordResidentDaemonRestartFailure(state, {
      at: new Date(START.getTime() + POLICY.openCooldownMs),
      failureSequence: 31
    });
    expect(reopened.state).toBe("open");
    expect(recordResidentDaemonRestartFailure(reopened, {
      at: new Date(START.getTime() - 1),
      failureSequence: 31
    })).toBe(reopened);
    expect(reopened.failureCount).toBe(1);
  });

  it("reclaims an abandoned half-open probe without closing the circuit", () => {
    let state = beginResidentDaemonRestartState({ ...POLICY, failureThreshold: 1 }, START);
    state = recordResidentDaemonRestartFailure(state, { at: START, failureSequence: 35 });
    state = decideResidentDaemonRestartAdmission(state, {
      generation: "probe_generation_01",
      now: new Date(START.getTime() + POLICY.openCooldownMs)
    }).receipt;
    const beforeExpiry = decideResidentDaemonRestartAdmission(state, {
      generation: "probe_generation_02",
      now: new Date(START.getTime() + (2 * POLICY.openCooldownMs) - 1)
    });
    expect(beforeExpiry.admission).toMatchObject({ delayMs: 1, state: "open" });
    const reclaimed = decideResidentDaemonRestartAdmission(state, {
      generation: "probe_generation_02",
      now: new Date(START.getTime() + (2 * POLICY.openCooldownMs))
    });
    expect(reclaimed.admission).toEqual({ state: "half-open-probe" });
    expect(reclaimed.receipt).toMatchObject({
      failureCount: 1,
      probeGeneration: "probe_generation_02",
      state: "half-open"
    });
  });

  it("clamps rollback clocks and owner reset closes the exact state", () => {
    let state = beginResidentDaemonRestartState({ ...POLICY, failureThreshold: 1 }, START);
    state = recordResidentDaemonRestartFailure(state, {
      at: new Date(START.getTime() - 60_000),
      failureSequence: 40
    });
    expect(state.updatedAt).toBe(START.toISOString());
    const reset = resetResidentDaemonRestartState(state, new Date(START.getTime() - 120_000));
    expect(reset).toMatchObject({
      failureCount: 0,
      lastFailureSequence: 40,
      state: "closed",
      updatedAt: START.toISOString()
    });
    expect(recordResidentDaemonRestartFailure(reset, {
      at: new Date(START.getTime() + 1),
      failureSequence: 40
    })).toBe(reset);
  });

  it("binds closed backoff admission to one generation until a new admission reassigns it", () => {
    let state = beginResidentDaemonRestartState(POLICY, START);
    state = recordResidentDaemonRestartFailure(state, { at: START, failureSequence: 45 });
    const admitted = decideResidentDaemonRestartAdmission(state, {
      generation: "admitted_generation_01",
      now: new Date(START.getTime() + POLICY.baseDelayMs)
    });
    expect(admitted.receipt).toMatchObject({
      admittedGeneration: "admitted_generation_01",
      failureCount: 1,
      state: "closed"
    });
    expect(() => recordResidentDaemonRestartSuccess(admitted.receipt, {
      generation: "wrong_generation_02",
      now: new Date(START.getTime() + POLICY.baseDelayMs)
    })).toThrow("admitted generation mismatch");
    const reassigned = decideResidentDaemonRestartAdmission(admitted.receipt, {
      generation: "replacement_generation_03",
      now: new Date(START.getTime() + POLICY.baseDelayMs)
    });
    expect(reassigned.receipt.admittedGeneration).toBe("replacement_generation_03");
    expect(recordResidentDaemonRestartSuccess(reassigned.receipt, {
      generation: "replacement_generation_03",
      now: new Date(START.getTime() + POLICY.baseDelayMs)
    })).toMatchObject({ failureCount: 0, state: "closed" });
  });

  it("binds and durably refreshes healthy closed evidence on current-generation ticks", () => {
    const started = beginResidentDaemonRestartState(POLICY, START);
    const admitted = decideResidentDaemonRestartAdmission(started, {
      generation: "healthy_generation_01",
      now: START
    }).receipt;
    expect(admitted).toMatchObject({
      admittedGeneration: "healthy_generation_01",
      successfulGeneration: null
    });
    expect(() => recordResidentDaemonRestartSuccess(admitted, {
      generation: "wrong_generation_02",
      now: START
    })).toThrow("admitted generation mismatch");
    const first = recordResidentDaemonRestartSuccess(admitted, {
      generation: "healthy_generation_01",
      now: START
    });
    const refreshed = recordResidentDaemonRestartSuccess(first, {
      generation: "healthy_generation_01",
      now: new Date(START.getTime() + 60_000)
    });
    expect(refreshed).toMatchObject({
      admittedGeneration: "healthy_generation_01",
      state: "closed",
      successfulGeneration: "healthy_generation_01",
      updatedAt: new Date(START.getTime() + 60_000).toISOString()
    });
    expect(refreshed.sequence).toBe(first.sequence + 1);
  });

  it("rejects partial, unknown, contradictory, and unsafe policy evidence", () => {
    const valid = beginResidentDaemonRestartState(POLICY, START);
    expect(parseResidentDaemonRestartStateReceipt(JSON.stringify(valid))).toEqual(valid);
    expect(parseResidentDaemonRestartStateReceipt("{\"version\":1")).toBeUndefined();
    expect(parseResidentDaemonRestartStateReceipt(JSON.stringify({ ...valid, private: true }))).toBeUndefined();
    expect(parseResidentDaemonRestartStateReceipt(JSON.stringify({
      ...valid,
      policy: { ...valid.policy, baseDelayMs: valid.policy.maxDelayMs + 1 }
    }))).toBeUndefined();
    expect(parseResidentDaemonRestartStateReceipt(JSON.stringify({
      ...valid,
      policy: {
        ...valid.policy,
        baseDelayMs: 3_000_000_000,
        maxDelayMs: 3_000_000_000
      }
    }))).toBeUndefined();
    expect(() => beginResidentDaemonRestartState({
      ...POLICY,
      failureThreshold: 1_001
    }, START)).toThrow("invalid resident restart state");
    expect(parseResidentDaemonRestartStateReceipt(JSON.stringify({
      ...valid,
      state: "open"
    }))).toBeUndefined();
    const admitted = decideResidentDaemonRestartAdmission(valid, {
      generation: "generation_AAAA",
      now: START
    }).receipt;
    const successful = recordResidentDaemonRestartSuccess(admitted, {
      generation: "generation_AAAA",
      now: START
    });
    expect(parseResidentDaemonRestartStateReceipt(JSON.stringify({
      ...successful,
      admittedGeneration: "generation_BBBB"
    }))).toBeUndefined();
    expect(parseResidentDaemonRestartStateReceipt(JSON.stringify({
      ...valid,
      failureCount: 1,
      lastFailureAt: START.toISOString(),
      lastFailureSequence: 1
    }))).toBeUndefined();
  });

  it("caps a large failure count without arithmetic overflow", () => {
    const initial = beginResidentDaemonRestartState({
      ...POLICY,
      failureThreshold: 1_000
    }, START);
    const highCount = {
      ...initial,
      failureCount: 998,
      lastFailureAt: START.toISOString(),
      lastFailureSequence: 100,
      notBeforeAt: new Date(START.getTime() + POLICY.maxDelayMs).toISOString()
    };
    expect(parseResidentDaemonRestartStateReceipt(JSON.stringify(highCount))).toEqual(highCount);
    expect(recordResidentDaemonRestartFailure(highCount, {
      at: new Date(START.getTime() + 1),
      failureSequence: 101
    })).toMatchObject({
      failureCount: 999,
      notBeforeAt: new Date(START.getTime() + 1 + POLICY.maxDelayMs).toISOString(),
      state: "closed"
    });
  });
});
