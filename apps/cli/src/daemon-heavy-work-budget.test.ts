import { describe, expect, it } from "vitest";

import { resolveDaemonHeavyWorkUnitsPerTick } from "./daemon-heavy-work-budget.js";

describe("daemon heavy-work budget", () => {
  it("uses unbounded execution unless an owner supplies a valid bounded cap", () => {
    expect(resolveDaemonHeavyWorkUnitsPerTick({})).toBe(0);
    expect(resolveDaemonHeavyWorkUnitsPerTick({ MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "0" })).toBe(0);
    expect(resolveDaemonHeavyWorkUnitsPerTick({ MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "3" })).toBe(3);
    expect(resolveDaemonHeavyWorkUnitsPerTick({ MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "-1" })).toBe(0);
    expect(resolveDaemonHeavyWorkUnitsPerTick({ MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "33" })).toBe(0);
  });
});
