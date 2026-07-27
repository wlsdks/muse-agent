import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";

import { createGracefulShutdown } from "./graceful-shutdown.js";

// The deadline is the contract: a hung cron drain or lingering socket
// must never keep a "stopped" server alive (observed live: a zombie
// still holding the Telegram long-poll against its replacement).

describe("graceful shutdown", () => {
  it("drains then closes, and a second call is a no-op", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      closeServer: async () => {
        calls.push("close");
      },
      closeResources: async () => {
        calls.push("resources");
      },
      drainScheduler: async () => {
        calls.push("drain");
      },
      exit: () => undefined,
      forceExitAfterMs: 1000
    });
    await shutdown();
    await shutdown();
    expect(calls).toEqual(["drain", "resources", "close"]);
  });

  it("a hung drain force-exits at the deadline instead of lingering forever", async () => {
    const logs: string[] = [];
    let exited: number | undefined;
    const shutdown = createGracefulShutdown({
      closeServer: async () => undefined,
      drainScheduler: () => Promise.withResolvers<never>().promise,
      exit: (code) => {
        exited = code;
      },
      forceExitAfterMs: 30,
      log: (m) => logs.push(m)
    });
    void shutdown();
    await sleep(80);
    expect(exited).toBe(0);
    expect(logs.some((l) => l.includes("forcing exit"))).toBe(true);
  });

  it("a hung owned-resource close remains covered by the same hard deadline", async () => {
    let exited: number | undefined;
    let serverClosed = false;
    const shutdown = createGracefulShutdown({
      closeResources: () => Promise.withResolvers<never>().promise,
      closeServer: async () => {
        serverClosed = true;
      },
      exit: (code) => {
        exited = code;
      },
      forceExitAfterMs: 30
    });

    void shutdown();
    await sleep(80);
    expect(exited).toBe(0);
    expect(serverClosed).toBe(false);
  });

  it("a fast drain never trips the deadline", async () => {
    let exited: number | undefined;
    const shutdown = createGracefulShutdown({
      closeServer: async () => undefined,
      drainScheduler: async () => undefined,
      exit: (code) => {
        exited = code;
      },
      forceExitAfterMs: 30
    });
    await shutdown();
    await sleep(60);
    expect(exited).toBeUndefined();
  });

  it("absorbs a close failure and keeps the forced-exit deadline armed", async () => {
    const logs: string[] = [];
    let exited: number | undefined;
    const shutdown = createGracefulShutdown({
      closeServer: async () => { throw new Error("close boom"); },
      exit: (code) => {
        exited = code;
      },
      forceExitAfterMs: 30,
      log: (message) => logs.push(message)
    });

    await expect(shutdown()).resolves.toBeUndefined();
    await sleep(80);

    expect(exited).toBe(0);
    expect(logs).toContain("server close failed; waiting for the forced-exit deadline");
  });

  it("still closes the server but keeps the deadline armed when resource shutdown fails", async () => {
    const calls: string[] = [];
    let exited: number | undefined;
    const shutdown = createGracefulShutdown({
      closeResources: async () => {
        calls.push("resources");
        throw new Error("resource close boom");
      },
      closeServer: async () => {
        calls.push("server");
      },
      exit: (code) => {
        exited = code;
      },
      forceExitAfterMs: 30,
      log: (message) => calls.push(message)
    });

    await expect(shutdown()).resolves.toBeUndefined();
    expect(calls.slice(0, 2)).toEqual(["resources", "resource close failed; continuing server close"]);
    expect(calls).toContain("server");
    await sleep(80);
    expect(exited).toBe(0);
  });
});
