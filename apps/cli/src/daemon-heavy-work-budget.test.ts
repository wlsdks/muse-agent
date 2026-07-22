import { describe, expect, it } from "vitest";

import { DaemonHeavyWorkQueue, resolveDaemonHeavyWorkUnitsPerTick } from "./daemon-heavy-work-budget.js";

describe("daemon heavy-work budget", () => {
  it("uses unbounded execution unless an owner supplies a valid bounded cap", () => {
    expect(resolveDaemonHeavyWorkUnitsPerTick({})).toBe(0);
    expect(resolveDaemonHeavyWorkUnitsPerTick({ MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "0" })).toBe(0);
    expect(resolveDaemonHeavyWorkUnitsPerTick({ MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "3" })).toBe(3);
    expect(resolveDaemonHeavyWorkUnitsPerTick({ MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "-1" })).toBe(0);
    expect(resolveDaemonHeavyWorkUnitsPerTick({ MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "33" })).toBe(0);
  });

  it("round-robins a bounded budget so later units cannot starve", async () => {
    const queue = new DaemonHeavyWorkQueue();
    const ran: string[] = [];
    const units = ["a", "b", "c"].map((id) => ({ id, run: async () => { ran.push(id); } }));

    await queue.run(units, 2);
    await queue.run(units, 2);
    await queue.run(units, 0);

    expect(ran).toEqual(["a", "b", "c", "a", "b", "c", "a"]);
  });

  it("checks cooperative stop before every lane", async () => {
    const queue = new DaemonHeavyWorkQueue();
    const ran: string[] = [];
    let keepRunning = true;
    await queue.run([
      { id: "first", run: async () => { ran.push("first"); keepRunning = false; } },
      { id: "second", run: async () => { ran.push("second"); } }
    ], 0, () => keepRunning);
    expect(ran).toEqual(["first"]);
  });

  it("advances past a throwing lane so later work cannot starve", async () => {
    const queue = new DaemonHeavyWorkQueue();
    const ran: string[] = [];
    const units = [
      { id: "bad", run: async () => { ran.push("bad"); throw new Error("boom"); } },
      { id: "good", run: async () => { ran.push("good"); } }
    ];
    await expect(queue.run(units, 1)).rejects.toThrow("boom");
    await queue.run(units, 1);
    expect(ran).toEqual(["bad", "good"]);
  });
});
