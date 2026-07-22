import { execFileSync } from "node:child_process";

export const MAC_RESOURCE_PROBE_TIMEOUT_MS = 5_000;
export const MAC_IDLE_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const MAC_POWER_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const MAC_THERMAL_PROBE_TIMEOUT_MS = 250;
export const MAC_THERMAL_OUTPUT_LIMIT_BYTES = 1_024;
export const MAC_THERMAL_JXA_SCRIPT = 'ObjC.import("Foundation"); const state = $.NSProcessInfo.processInfo.thermalState; state === $.NSProcessInfoThermalStateNominal ? "nominal" : state === $.NSProcessInfoThermalStateFair ? "fair" : state === $.NSProcessInfoThermalStateSerious ? "serious" : state === $.NSProcessInfoThermalStateCritical ? "critical" : "unavailable";';

const IOREG_PATH = "/usr/sbin/ioreg";
const PMSET_PATH = "/usr/bin/pmset";
const OSASCRIPT_PATH = "/usr/bin/osascript";

export type MacThermalState = "nominal" | "fair" | "serious" | "critical";

export type MacResourceProbe = (
  executable: string,
  args: readonly string[],
  options: { readonly maxBuffer: number; readonly timeout: number }
) => string;

export function parseHidIdleSeconds(ioregOutput: string): number | undefined {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/u.exec(ioregOutput);
  if (!match) return undefined;
  const nanos = Number(match[1]);
  return Number.isFinite(nanos) && nanos >= 0 ? nanos / 1e9 : undefined;
}

export function parseOnAcPower(pmsetBattOutput: string): boolean | undefined {
  if (/drawing from '?AC Power'?/iu.test(pmsetBattOutput)) return true;
  if (/drawing from '?Battery Power'?/iu.test(pmsetBattOutput)) return false;
  return undefined;
}

export function parseThermalState(output: string): MacThermalState | undefined {
  const state = output.trim();
  return state === "nominal" || state === "fair" || state === "serious" || state === "critical"
    ? state
    : undefined;
}

export function readMacIdleMs(
  runIoreg: MacResourceProbe = defaultIoreg,
  platform: NodeJS.Platform = process.platform
): number | undefined {
  if (platform !== "darwin") return undefined;
  try {
    const seconds = parseHidIdleSeconds(runIoreg(
      IOREG_PATH,
      ["-r", "-c", "IOHIDSystem", "-d", "1"],
      { maxBuffer: MAC_IDLE_OUTPUT_LIMIT_BYTES, timeout: MAC_RESOURCE_PROBE_TIMEOUT_MS }
    ));
    return seconds === undefined ? undefined : Math.round(seconds * 1_000);
  } catch {
    return undefined;
  }
}

export function readMacAcPower(
  runPmset: MacResourceProbe = defaultPmset,
  platform: NodeJS.Platform = process.platform
): boolean | undefined {
  if (platform !== "darwin") return undefined;
  try {
    return parseOnAcPower(runPmset(
      PMSET_PATH,
      ["-g", "batt"],
      { maxBuffer: MAC_POWER_OUTPUT_LIMIT_BYTES, timeout: MAC_RESOURCE_PROBE_TIMEOUT_MS }
    ));
  } catch {
    return undefined;
  }
}

export function readMacThermalState(
  runOsascript: MacResourceProbe = defaultOsascript,
  platform: NodeJS.Platform = process.platform
): MacThermalState | undefined {
  if (platform !== "darwin") return undefined;
  try {
    return parseThermalState(runOsascript(
      OSASCRIPT_PATH,
      ["-l", "JavaScript", "-e", MAC_THERMAL_JXA_SCRIPT],
      { maxBuffer: MAC_THERMAL_OUTPUT_LIMIT_BYTES, timeout: MAC_THERMAL_PROBE_TIMEOUT_MS }
    ));
  } catch {
    return undefined;
  }
}

export function isOsIdleEnough(idleMs: number | undefined, thresholdMs: number): boolean {
  return idleMs !== undefined && idleMs >= thresholdMs;
}

export function isPowerOkForLlm(onAcPower: boolean | undefined): boolean {
  return onAcPower === true;
}

function defaultIoreg(executable: string, args: readonly string[], options: { readonly maxBuffer: number; readonly timeout: number }): string {
  return execFileSync(executable, [...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer,
    timeout: options.timeout
  });
}

const defaultPmset = defaultIoreg;

function defaultOsascript(executable: string, args: readonly string[], options: { readonly maxBuffer: number; readonly timeout: number }): string {
  return execFileSync(executable, [...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout
  });
}
