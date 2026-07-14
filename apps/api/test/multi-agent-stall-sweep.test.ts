import { SubAgentRunRegistry } from "@muse/multi-agent";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";

import { registerMultiAgentRoutes, resolveStallSweepMs } from "../src/multi-agent-routes.js";

// The on-read sweep (GET /runs) only fires when someone polls; the
// background sweep is what turns a hung run into a terminal `timed-out`
// record with NOBODY watching — the whole point of stall detection on an
// unattended daemon. These tests pin that outcome and the interval's
// lifecycle (cleared on close, disable-at-0).

const sleepMs = (ms: number) => sleep(ms);

describe("resolveStallSweepMs", () => {
  it("defaults to 30s on unset, empty, and non-numeric values", () => {
    expect(resolveStallSweepMs({})).toBe(30_000);
    expect(resolveStallSweepMs({ MUSE_MULTI_AGENT_STALL_SWEEP_MS: "" })).toBe(30_000);
    expect(resolveStallSweepMs({ MUSE_MULTI_AGENT_STALL_SWEEP_MS: "30s" })).toBe(30_000);
    expect(resolveStallSweepMs({ MUSE_MULTI_AGENT_STALL_SWEEP_MS: "-5" })).toBe(30_000);
  });

  it("parses a whole-token decimal and honours 0 as disable", () => {
    expect(resolveStallSweepMs({ MUSE_MULTI_AGENT_STALL_SWEEP_MS: "5000" })).toBe(5_000);
    expect(resolveStallSweepMs({ MUSE_MULTI_AGENT_STALL_SWEEP_MS: "0" })).toBe(0);
  });
});

describe("background stall sweep (registered via registerMultiAgentRoutes)", () => {
  const envKey = "MUSE_MULTI_AGENT_STALL_SWEEP_MS";
  const original = process.env[envKey];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = original;
    }
  });

  it("marks a heartbeat-silent run timed-out WITHOUT any HTTP read", async () => {
    process.env[envKey] = "20";
    const registry = new SubAgentRunRegistry({ defaultTimeoutMs: 10 });
    registry.register({ runId: "hung-run" });
    const app = Fastify();
    registerMultiAgentRoutes(app, { runRegistry: registry });
    await app.ready();
    try {
      await sleepMs(120);
      expect(registry.get("hung-run")?.status).toBe("timed-out");
    } finally {
      await app.close();
    }
  });

  it("stops sweeping after server close (no timer leak keeps mutating state)", async () => {
    process.env[envKey] = "20";
    const registry = new SubAgentRunRegistry({ defaultTimeoutMs: 10 });
    const app = Fastify();
    registerMultiAgentRoutes(app, { runRegistry: registry });
    await app.ready();
    await app.close();
    registry.register({ runId: "post-close-run" });
    await sleepMs(120);
    expect(registry.get("post-close-run")?.status).toBe("running");
  });

  it("sweep disabled at 0 — a stalled run stays running until an on-read sweep", async () => {
    process.env[envKey] = "0";
    const registry = new SubAgentRunRegistry({ defaultTimeoutMs: 10 });
    registry.register({ runId: "unswept-run" });
    const app = Fastify();
    registerMultiAgentRoutes(app, { runRegistry: registry });
    await app.ready();
    try {
      await sleepMs(120);
      expect(registry.get("unswept-run")?.status).toBe("running");
    } finally {
      await app.close();
    }
  });
});
