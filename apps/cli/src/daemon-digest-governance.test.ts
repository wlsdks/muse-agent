import { MessagingProviderRegistry } from "@muse/messaging";
import { describe, expect, it, vi } from "vitest";

import { DaemonStopSignal } from "./commands-daemon-loop.js";
import { makeDigestFlushTick, type MakeDigestFlushTickDeps } from "./daemon-selflearn-ticks.js";
import { DaemonWorkloadGovernor, daemonWorkloadCompleted } from "./daemon-workload-governor.js";

const NOW = new Date(2026, 6, 12, 18, 5, 0);

function makeTick(
  digestFlush: NonNullable<MakeDigestFlushTickDeps["digestFlush"]>,
  stdout: (message: string) => void = () => undefined
) {
  return makeDigestFlushTick({
    channelOwnersFile: "/tmp/muse-test-channel-owners.json",
    dayRhythmConfigFile: "/tmp/muse-test-day-rhythm.json",
    destination: "local",
    digestEnabled: true,
    digestFlush,
    digestHourRaw: 18,
    digestQueueFile: "/tmp/muse-test-digest-queue.json",
    digestSentFile: "/tmp/muse-test-digest-sent.json",
    messagingRegistry: new MessagingProviderRegistry(),
    now: () => NOW,
    provider: "log",
    quietHours: undefined,
    stdout
  });
}

describe("governed digest claim accounting", () => {
  it.each([
    ["not-due", "not-due"],
    ["already-sent-today", "not-due"],
    ["empty", "not-due"],
    ["lock-held", "internal-brake"],
    ["lock-error", "internal-brake"],
    ["preflight-failed", "internal-brake"]
  ] as const)("maps %s to free not-ready work", async (outcome, reason) => {
    const claim = vi.fn(() => true);
    const tick = makeTick(async () => ({
      errors: outcome === "lock-error" || outcome === "preflight-failed" ? ["visible"] : [],
      itemCount: 0,
      outcome
    }));

    await expect(tick(claim)).resolves.toEqual({ reason, status: "not-ready" });
    expect(claim).not.toHaveBeenCalled();
  });

  it("maps a rejected core claim to cancellation without a boundary", async () => {
    const claim = vi.fn(() => false);
    const tick = makeTick(async (options) => {
      expect(options.claim?.()).toBe(false);
      return { errors: [], itemCount: 1, outcome: "cancelled-before-claim" };
    });

    await expect(tick(claim)).resolves.toEqual({ status: "cancelled-before-claim" });
    expect(claim).toHaveBeenCalledOnce();
  });

  it.each([
    ["sent", { status: "claimed-completed" }],
    ["send-failed", { errorClass: "provider", status: "claimed-failed" }]
  ] as const)("maps claimed %s truthfully", async (outcome, expected) => {
    const claim = vi.fn(() => true);
    const tick = makeTick(async (options) => {
      expect(options.claim?.()).toBe(true);
      return { errors: outcome === "send-failed" ? ["provider down"] : [], itemCount: 1, outcome };
    });

    await expect(tick(claim)).resolves.toEqual(expected);
    expect(claim).toHaveBeenCalledOnce();
  });

  it("lets a ready sibling consume the boundary when the digest snapshot is empty", async () => {
    const digestClaims = vi.fn(() => true);
    const digest = makeTick(async () => ({ errors: [], itemCount: 0, outcome: "empty" }));
    const siblingClaims = vi.fn();
    const governor = new DaemonWorkloadGovernor([
      { id: "digest-flush", run: (claim) => digest(() => { digestClaims(); return claim?.() ?? true; }) },
      {
        id: "browsing-sync",
        run: async (claim) => {
          expect(claim?.()).toBe(true);
          siblingClaims();
          return daemonWorkloadCompleted();
        }
      }
    ]);

    const result = await governor.runAdmittedCycle(new DaemonStopSignal());
    expect(result).toMatchObject({ boundary: { unit: "browsing-sync" }, status: "boundary" });
    expect(digestClaims).not.toHaveBeenCalled();
    expect(siblingClaims).toHaveBeenCalledOnce();
  });
});
