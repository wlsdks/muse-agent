import { describe, expect, it } from "vitest";

import { createGracefulShutdown } from "../src/graceful-shutdown.js";

describe("createGracefulShutdown", () => {
  it("drains the scheduler BEFORE closing the server", async () => {
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      drainScheduler: async () => { order.push("drain"); },
      closeServer: async () => { order.push("close"); }
    });
    await shutdown();
    expect(order).toEqual(["drain", "close"]);
  });

  it("is idempotent — a second signal does not drain/close again", async () => {
    let closes = 0;
    const shutdown = createGracefulShutdown({ closeServer: async () => { closes += 1; } });
    await shutdown();
    await shutdown();
    expect(closes).toBe(1);
  });

  it("still closes the server when the drain throws (best-effort drain)", async () => {
    let closed = false;
    const shutdown = createGracefulShutdown({
      drainScheduler: async () => { throw new Error("drain boom"); },
      closeServer: async () => { closed = true; }
    });
    await expect(shutdown()).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });

  it("closes directly when no scheduler is present", async () => {
    let closed = false;
    const shutdown = createGracefulShutdown({ closeServer: async () => { closed = true; } });
    await shutdown();
    expect(closed).toBe(true);
  });
});
