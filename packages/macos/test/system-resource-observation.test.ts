import { describe, expect, it } from "vitest";

import {
  isOsIdleEnough,
  isPowerOkForLlm,
  parseHidIdleSeconds,
  parseOnAcPower,
  readMacAcPower,
  readMacIdleMs
} from "../src/system-resource-observation.js";

describe("macOS system resource observation", () => {
  it("parses canonical HID idle and power-source output", () => {
    expect(parseHidIdleSeconds('"HIDIdleTime" = 90000000000')).toBe(90);
    expect(parseHidIdleSeconds('"HIDIdleTime" = not-a-number')).toBeUndefined();
    expect(parseOnAcPower("Now drawing from 'AC Power'")).toBe(true);
    expect(parseOnAcPower("Now drawing from 'Battery Power'")).toBe(false);
    expect(parseOnAcPower("unknown")).toBeUndefined();
  });

  it("uses an exact platform seam and fails closed on malformed or throwing probes", () => {
    expect(readMacIdleMs(() => '"HIDIdleTime" = 5000000000', "darwin")).toBe(5_000);
    expect(readMacAcPower(() => "Now drawing from 'AC Power'", "darwin")).toBe(true);
    expect(readMacIdleMs(() => '"HIDIdleTime" = 5000000000', "linux")).toBeUndefined();
    expect(readMacAcPower(() => "Now drawing from 'AC Power'", "win32")).toBeUndefined();
    expect(readMacIdleMs(() => { throw new Error("missing"); }, "darwin")).toBeUndefined();
    expect(readMacAcPower(() => "malformed", "darwin")).toBeUndefined();
  });

  it("keeps equality inclusive and unknown power fail closed", () => {
    expect(isOsIdleEnough(300_000, 300_000)).toBe(true);
    expect(isOsIdleEnough(299_999, 300_000)).toBe(false);
    expect(isOsIdleEnough(undefined, 300_000)).toBe(false);
    expect(isPowerOkForLlm(true)).toBe(true);
    expect(isPowerOkForLlm(false)).toBe(false);
    expect(isPowerOkForLlm(undefined)).toBe(false);
  });
});
