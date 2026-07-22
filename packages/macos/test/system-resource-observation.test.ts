import { describe, expect, it } from "vitest";

import {
  MAC_THERMAL_JXA_SCRIPT,
  MAC_THERMAL_OUTPUT_LIMIT_BYTES,
  MAC_THERMAL_PROBE_TIMEOUT_MS,
  isOsIdleEnough,
  isPowerOkForLlm,
  parseHidIdleSeconds,
  parseOnAcPower,
  parseThermalState,
  readMacAcPower,
  readMacIdleMs,
  readMacThermalState
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

  it("strictly accepts only the four bounded Foundation thermal labels", () => {
    expect(parseThermalState("nominal\n")).toBe("nominal");
    expect(parseThermalState(" fair ")).toBe("fair");
    expect(parseThermalState("serious")).toBe("serious");
    expect(parseThermalState("critical")).toBe("critical");
    for (const output of ["", "0", "nominal extra", "unavailable", "unknown", "SERIOUS"]) {
      expect(parseThermalState(output)).toBeUndefined();
    }
  });

  it("reads the public thermal state through one exact bounded system command", () => {
    const calls: { executable: string; args: readonly string[]; maxBuffer: number; timeout: number }[] = [];
    const probe = (executable: string, args: readonly string[], options: { readonly maxBuffer: number; readonly timeout: number }) => {
      calls.push({ args, executable, maxBuffer: options.maxBuffer, timeout: options.timeout });
      return "serious\n";
    };
    expect(readMacThermalState(probe, "darwin")).toBe("serious");
    expect(calls).toEqual([{
      args: ["-l", "JavaScript", "-e", MAC_THERMAL_JXA_SCRIPT],
      executable: "/usr/bin/osascript",
      maxBuffer: MAC_THERMAL_OUTPUT_LIMIT_BYTES,
      timeout: MAC_THERMAL_PROBE_TIMEOUT_MS
    }]);
    expect(MAC_THERMAL_PROBE_TIMEOUT_MS).toBe(250);
    expect(MAC_THERMAL_OUTPUT_LIMIT_BYTES).toBe(1_024);
    expect(MAC_THERMAL_JXA_SCRIPT).toContain("NSProcessInfoThermalStateNominal");
    expect(MAC_THERMAL_JXA_SCRIPT).toContain("NSProcessInfoThermalStateCritical");
  });

  it("starts no thermal process off macOS and collapses failures or sentinels to unavailable", () => {
    let starts = 0;
    const probe = () => { starts += 1; return "nominal"; };
    expect(readMacThermalState(probe, "linux")).toBeUndefined();
    expect(starts).toBe(0);
    expect(readMacThermalState(() => "unavailable", "darwin")).toBeUndefined();
    expect(readMacThermalState(() => { throw new Error("private stderr"); }, "darwin")).toBeUndefined();
  });

  it("scopes IORegistry to the direct IOHIDSystem service instead of reading the full registry tree", () => {
    const calls: { executable: string; args: readonly string[]; maxBuffer: number }[] = [];
    const probe = (executable: string, args: readonly string[], options: { readonly maxBuffer: number }) => {
      calls.push({ args, executable, maxBuffer: options.maxBuffer });
      return '"HIDIdleTime" = 5000000000';
    };
    expect(readMacIdleMs(probe, "darwin")).toBe(5_000);
    expect(calls).toEqual([{
      args: ["-r", "-c", "IOHIDSystem", "-d", "1"],
      executable: "/usr/sbin/ioreg",
      maxBuffer: 256 * 1024
    }]);
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
