import { describe, expect, it } from "vitest";

import {
  isIdleForConsolidate,
  startConsolidateTick,
  type ConsolidateMergeOutcome
} from "./consolidate-tick.js";

const IDLE_MS = 30 * 60_000;
// Local-time 03:00 so getHours() === 3 regardless of the runner's timezone.
const NOW = new Date(2026, 4, 1, 3, 0, 0);

function baseOptions(overrides: Partial<Parameters<typeof startConsolidateTick>[0]> = {}): Parameters<typeof startConsolidateTick>[0] {
  return {
    authoredSkillsDir: "/tmp/unused",
    lastActivityMs: () => undefined,
    model: "qwen3:8b",
    modelProvider: { generate: async () => ({}) } as unknown as Parameters<typeof startConsolidateTick>[0]["modelProvider"],
    idleThresholdMs: IDLE_MS,
    now: () => NOW,
    runConsolidate: async () => [],
    ...overrides
  };
}

describe("isIdleForConsolidate", () => {
  it("is idle only with a stamp at least the threshold old; unknown activity is NOT idle", () => {
    const now = 1_000_000;
    expect(isIdleForConsolidate(now, undefined, IDLE_MS)).toBe(false);
    expect(isIdleForConsolidate(now, now - IDLE_MS, IDLE_MS)).toBe(true);
    expect(isIdleForConsolidate(now, now - IDLE_MS + 1, IDLE_MS)).toBe(false);
    expect(isIdleForConsolidate(now, now - 2 * IDLE_MS, IDLE_MS)).toBe(true);
  });
});

describe("startConsolidateTick.tickOnce — idle gate", () => {
  it("does NOT consolidate when the user is active (recent activity)", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - 60_000, // 1 min ago — still active
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("consolidates and logs each umbrella once idle past the threshold", async () => {
    const logs: string[] = [];
    const merged: readonly ConsolidateMergeOutcome[] = [{ umbrella: "email-handling", merged: ["draft-reply", "send-followup"] }];
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1, // just over the threshold
      logger: (m) => logs.push(m),
      runConsolidate: async () => { calls += 1; return merged; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(1);
    expect(logs).toEqual(["consolidate-tick: folded 2 skills → email-handling"]);
  });

  it("skips during quiet hours even when idle", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      quietHours: { startHour: 0, endHour: 6 }, // 03:00Z is inside
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("never throws when the consolidate run fails — routes to errorLogger", async () => {
    const errors: string[] = [];
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      errorLogger: (m) => errors.push(m),
      runConsolidate: async () => { throw new Error("merge boom"); }
    }));
    await expect(handle.tickOnce()).resolves.toBeUndefined();
    handle.stop();
    expect(errors).toEqual(["consolidate-tick: merge boom"]);
  });
});

describe("startConsolidateTick.tickOnce — REAL OS-idle brake (B1 brake-first)", () => {
  // API-idle holds in all three; only the OS-idle probe varies.
  const apiIdle = { lastActivityMs: () => NOW.getTime() - IDLE_MS - 1 };

  it("does NOT consolidate when the OS is busy, even though Muse's /api is quiet", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...apiIdle,
      osIdleMs: () => 60_000, // OS idle only 1 min < 30 min threshold → busy in another app
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("does NOT consolidate when the OS-idle probe is unknown (fail-closed)", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...apiIdle,
      osIdleMs: () => undefined, // probe failed / non-macOS → never run unattended
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("consolidates when BOTH Muse /api AND the OS are idle past the threshold", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...apiIdle,
      osIdleMs: () => IDLE_MS + 1,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(1);
  });
});

describe("startConsolidateTick.tickOnce — model-resident brake (never cold-load unattended)", () => {
  const idle = { lastActivityMs: () => NOW.getTime() - IDLE_MS - 1 };

  it("does NOT consolidate when the model is not resident (would cold-load)", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...idle,
      isModelResident: async () => false,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("consolidates when idle AND the model is already resident", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...idle,
      isModelResident: async () => true,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(1);
  });
});
