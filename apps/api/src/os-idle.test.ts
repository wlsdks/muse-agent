import { describe, expect, it } from "vitest";

import { isOsIdleEnough, osIdleMs, parseHidIdleSeconds } from "./os-idle.js";

describe("parseHidIdleSeconds — read system-wide HID idle from ioreg output", () => {
  it("parses HIDIdleTime nanoseconds → seconds", () => {
    // 90s idle = 90_000_000_000 ns
    expect(parseHidIdleSeconds('  | |   "HIDIdleTime" = 90000000000')).toBe(90);
    expect(parseHidIdleSeconds('"HIDIdleTime"=1500000000')).toBe(1.5);
  });

  it("returns undefined (fail-closed) when the field is absent or garbage", () => {
    expect(parseHidIdleSeconds("no idle field here")).toBeUndefined();
    expect(parseHidIdleSeconds('"HIDIdleTime" = notanumber')).toBeUndefined();
  });
});

describe("osIdleMs — fail-closed probe", () => {
  it("returns ms when the injected ioreg yields a value", () => {
    if (process.platform !== "darwin") {
      // off macOS the probe is intentionally undefined; assert that floor
      expect(osIdleMs(() => '"HIDIdleTime" = 5000000000')).toBeUndefined();
      return;
    }
    expect(osIdleMs(() => '"HIDIdleTime" = 5000000000')).toBe(5000);
  });

  it("returns undefined when ioreg throws (fail-closed)", () => {
    expect(osIdleMs(() => { throw new Error("ioreg missing"); })).toBeUndefined();
  });
});

describe("isOsIdleEnough — brake predicate (fail-closed on unknown)", () => {
  it("undefined OS idle is NOT idle (never run unattended without proof)", () => {
    expect(isOsIdleEnough(undefined, 1000)).toBe(false);
  });

  it("below threshold is not idle; at/above threshold is idle", () => {
    expect(isOsIdleEnough(500, 1000)).toBe(false);
    expect(isOsIdleEnough(1000, 1000)).toBe(true);
    expect(isOsIdleEnough(60_000, 30_000)).toBe(true);
  });
});
