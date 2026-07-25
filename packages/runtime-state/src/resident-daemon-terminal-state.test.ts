import { describe, expect, it } from "vitest";

import {
  appendResidentDaemonFailure,
  beginResidentDaemonTerminalGeneration,
  classifyResidentDaemonFailure,
  markResidentDaemonStable,
  parseResidentDaemonTerminalStateReceipt,
  RESIDENT_DAEMON_FAILURE_HISTORY_LIMIT
} from "./resident-daemon-terminal-state.js";

const START = new Date("2026-07-22T03:00:00.000Z");

describe("resident daemon terminal state contract", () => {
  it.each([
    ["config", new SyntaxError("PRIVATE /owner/config.json"), { domain: "config" as const }, "configuration-invalid", "configuration"],
    ["store corruption", new Error("PRIVATE user record"), { domain: "store" as const }, "store-corrupt", "data-integrity"],
    ["provider auth", Object.assign(new Error("Bearer PRIVATE"), { status: 401 }), { domain: "provider" as const }, "provider-auth-failed", "authentication"],
    ["port collision", Object.assign(new Error("PRIVATE localhost"), { code: "EADDRINUSE" }), {}, "port-collision", "resource-conflict"],
    ["uncaught exception", new TypeError("PRIVATE stack"), { domain: "runtime" as const }, "uncaught-exception", "defect"]
  ])("classifies %s without retaining raw error content", (_name, cause, context, reasonCode, exitClass) => {
    expect(classifyResidentDaemonFailure(cause, context)).toEqual({ exitClass, reasonCode });
  });

  it("records bounded privacy-safe failures and explicit stable points", () => {
    let receipt = beginResidentDaemonTerminalGeneration({
      generation: "resident_generation_01",
      now: START,
      pid: 4321
    });
    receipt = markResidentDaemonStable(
      receipt,
      "heartbeat-established",
      new Date("2026-07-22T03:01:00.000Z")
    );
    for (let index = 0; index < RESIDENT_DAEMON_FAILURE_HISTORY_LIMIT + 2; index += 1) {
      receipt = appendResidentDaemonFailure(receipt, {
        cause: new Error(`PRIVATE secret ${index.toString()} /Users/owner`),
        context: { domain: index % 2 === 0 ? "store" : "runtime" },
        id: `failure_${index.toString().padStart(2, "0")}`,
        now: new Date(START.getTime() + (index + 2) * 60_000)
      });
    }

    expect(receipt.failures).toHaveLength(RESIDENT_DAEMON_FAILURE_HISTORY_LIMIT);
    expect(receipt.failures.at(-1)).toMatchObject({
      diagnosticRef: "muse://resident-diagnostics/failure_09",
      lastStablePoint: "heartbeat-established",
      reasonCode: "uncaught-exception"
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toMatch(/PRIVATE|secret|Users|owner/iu);
    expect(parseResidentDaemonTerminalStateReceipt(serialized)).toEqual(receipt);
  });

  it("keeps sequence and stable timestamps monotonic across clock rollback and replacement generation", () => {
    const first = beginResidentDaemonTerminalGeneration({
      generation: "resident_generation_01",
      now: START,
      pid: 4321
    });
    const stable = markResidentDaemonStable(
      first,
      "tick-completed",
      new Date("2026-07-22T02:00:00.000Z")
    );
    const replacement = beginResidentDaemonTerminalGeneration({
      generation: "resident_generation_02",
      now: new Date("2026-07-22T01:00:00.000Z"),
      pid: 9876,
      previous: stable
    });

    expect(stable.lastStableAt).toBe(first.updatedAt);
    expect(replacement.updatedAt).toBe(stable.updatedAt);
    expect(replacement.sequence).toBe(stable.sequence + 1);
    expect(replacement).toMatchObject({
      generation: "resident_generation_02",
      lastStablePoint: "entry",
      pid: 9876,
      status: "running"
    });
  });

  it("makes failure terminal for a generation and rejects stable-point regression", () => {
    const started = beginResidentDaemonTerminalGeneration({
      generation: "resident_generation_01",
      now: START,
      pid: 4321
    });
    const stable = markResidentDaemonStable(
      started,
      "runtime-initialized",
      new Date("2026-07-22T03:01:00.000Z")
    );
    expect(() => markResidentDaemonStable(stable, "heartbeat-established", START))
      .toThrow("stable point cannot regress");

    const failed = appendResidentDaemonFailure(stable, {
      cause: new Error("PRIVATE"),
      id: "failure_terminal_01",
      now: new Date("2026-07-22T03:02:00.000Z")
    });
    expect(() => markResidentDaemonStable(failed, "tick-completed", START))
      .toThrow("failure is final");
    expect(parseResidentDaemonTerminalStateReceipt(JSON.stringify({
      ...failed,
      sequence: failed.sequence + 1,
      status: "running"
    }))).toBeUndefined();
  });

  it("rejects contradictory reason-code and exit-class evidence", () => {
    const failed = appendResidentDaemonFailure(
      beginResidentDaemonTerminalGeneration({
        generation: "resident_generation_01",
        now: START,
        pid: 4321
      }),
      {
        cause: Object.assign(new Error("PRIVATE"), { status: 401 }),
        id: "failure_pair_01",
        now: new Date("2026-07-22T03:01:00.000Z")
      }
    );
    expect(parseResidentDaemonTerminalStateReceipt(JSON.stringify({
      ...failed,
      failures: failed.failures.map((failure) => ({ ...failure, exitClass: "defect" }))
    }))).toBeUndefined();
  });

  it.each([
    ["partial", "{\"version\":1"],
    ["unknown key", JSON.stringify({
      ...beginResidentDaemonTerminalGeneration({
        generation: "resident_generation_01",
        now: START,
        pid: 4321
      }),
      private: "hidden"
    })],
    ["raw diagnostic link", JSON.stringify({
      ...appendResidentDaemonFailure(
        beginResidentDaemonTerminalGeneration({
          generation: "resident_generation_01",
          now: START,
          pid: 4321
        }),
        {
          cause: new Error("private"),
          id: "failure_01",
          now: START
        }
      ),
      failures: [{
        ...appendResidentDaemonFailure(
          beginResidentDaemonTerminalGeneration({
            generation: "resident_generation_01",
            now: START,
            pid: 4321
          }),
          {
            cause: new Error("private"),
            id: "failure_01",
            now: START
          }
        ).failures[0],
        diagnosticRef: "file:///Users/owner/private.log"
      }]
    })]
  ])("rejects %s evidence", (_name, text) => {
    expect(parseResidentDaemonTerminalStateReceipt(text)).toBeUndefined();
  });
});
