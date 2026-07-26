import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { dispatchOutboundEffectOnce } from "../src/outbound-effect-dispatch.js";
import { readOutboundEffect, reconcileOutboundEffect } from "../src/outbound-effect-store.js";

const FIRST = new Date("2026-07-26T13:00:00.000Z");
const LATER = new Date("2026-07-26T13:01:00.000Z");

let file: string;

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), "muse-effect-dispatch-")), "effects.json");
});

function options(overrides: Record<string, unknown> = {}) {
  const sends: Array<{ providerId: string; message: { destination: string; idempotencyKey?: string; text: string } }> = [];
  return {
    sends,
    value: {
      destination: "C123",
      effectFile: file,
      effectId: "effect-1",
      now: () => FIRST,
      providerId: "slack",
      registry: {
        send: async (providerId: string, message: { destination: string; idempotencyKey?: string; text: string }) => {
          sends.push({ message, providerId });
          return { destination: message.destination, messageId: "m-1", providerId };
        }
      },
      text: "hello",
      ...overrides
    }
  };
}

describe("dispatchOutboundEffectOnce", () => {
  it("persists an accepted receipt and exact replay makes zero further provider calls", async () => {
    const call = options();
    expect((await dispatchOutboundEffectOnce(call.value)).state).toBe("accepted");
    expect(call.sends).toEqual([{
      message: { destination: "C123", idempotencyKey: "effect-1", text: "hello" },
      providerId: "slack"
    }]);

    const restarted = options({ now: () => LATER });
    expect((await dispatchOutboundEffectOnce(restarted.value)).state).toBe("accepted");
    expect(restarted.sends).toHaveLength(0);
  });

  it("records success-before-ack and timeout as unknown, then never retries after restart", async () => {
    let calls = 0;
    const first = options({
      registry: {
        send: async () => {
          calls += 1;
          throw new Error("timeout after provider accepted");
        }
      }
    });
    expect((await dispatchOutboundEffectOnce(first.value)).state).toBe("unknown");
    expect(calls).toBe(1);

    const restarted = options({ now: () => LATER });
    expect((await dispatchOutboundEffectOnce(restarted.value)).state).toBe("unknown");
    expect(restarted.sends).toHaveLength(0);
  });

  it("fails binding drift before any provider call", async () => {
    const first = options();
    await dispatchOutboundEffectOnce(first.value);
    const drifted = options({ destination: "C999", now: () => LATER });

    await expect(dispatchOutboundEffectOnce(drifted.value)).rejects.toThrow(/different payload/iu);
    expect(drifted.sends).toHaveLength(0);
  });

  it("gives only one concurrent caller dispatch ownership", async () => {
    let releaseProvider: (() => void) | undefined;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    let calls = 0;
    const registry = {
      send: async () => {
        calls += 1;
        markProviderStarted?.();
        await providerRelease;
        return { destination: "C123", messageId: "m-1", providerId: "slack" };
      }
    };
    const first = options({ registry });
    const second = options({ now: () => LATER, registry });
    const firstPromise = dispatchOutboundEffectOnce(first.value);
    await providerStarted;
    const secondPromise = dispatchOutboundEffectOnce(second.value);
    releaseProvider?.();
    const states = (await Promise.all([firstPromise, secondPromise])).map((view) => view.state);

    expect(calls).toBe(1);
    expect(states.every((state) => state === "accepted" || state === "unknown")).toBe(true);
    expect((await readOutboundEffect(file, "effect-1"))?.state).toBe(states[1]);
  });

  it("does not send a crash-left prepared effect and permits only explicit reconciliation", async () => {
    const acquired = options();
    const { acquireOutboundEffectDispatch, computeOutboundEffectPayloadHash } = await import("../src/index.js");
    await acquireOutboundEffectDispatch(file, {
      destination: "C123",
      effectId: "effect-1",
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "C123",
        providerId: "slack",
        text: "hello"
      }),
      providerId: "slack"
    }, FIRST.toISOString());

    const view = await dispatchOutboundEffectOnce({ ...acquired.value, now: () => LATER });
    expect(view.state).toBe("unknown");
    expect(acquired.sends).toHaveLength(0);
    expect((await reconcileOutboundEffect(file, {
      actor: "owner",
      decision: "not-delivered",
      effectId: "effect-1",
      reason: "provider history checked",
      recordedAt: "2026-07-26T13:02:00.000Z"
    })).state).toBe("reconciled-not-delivered");

    const replay = options({ now: () => new Date("2026-07-26T13:03:00.000Z") });
    expect((await dispatchOutboundEffectOnce(replay.value)).state).toBe("reconciled-not-delivered");
    expect(replay.sends).toHaveLength(0);
  });

  it("hashes and sends the same secret-redacted wire payload", async () => {
    const call = options({ text: "token sk-12345678901234567890" });
    await dispatchOutboundEffectOnce(call.value);
    expect(call.sends[0]?.message.text).not.toContain("sk-12345678901234567890");
  });

  it("snapshots caller options and the registry method before its first await", async () => {
    const call = options();
    const mutable = call.value as typeof call.value & {
      destination: string;
      effectId: string;
      providerId: string;
      text: string;
    };
    const dispatch = dispatchOutboundEffectOnce(mutable);
    mutable.destination = "mutated";
    mutable.effectId = "mutated";
    mutable.providerId = "mutated";
    mutable.text = "mutated";
    mutable.registry.send = async () => {
      throw new Error("mutated registry must not run");
    };

    expect((await dispatch).state).toBe("accepted");
    expect(call.sends).toEqual([{
      message: { destination: "C123", idempotencyKey: "effect-1", text: "hello" },
      providerId: "slack"
    }]);
  });
});
