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
});
