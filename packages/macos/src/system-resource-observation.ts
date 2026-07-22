import { execFileSync } from "node:child_process";

export const MAC_RESOURCE_PROBE_TIMEOUT_MS = 5_000;
export const MAC_IDLE_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const MAC_POWER_OUTPUT_LIMIT_BYTES = 64 * 1024;

const IOREG_PATH = "/usr/sbin/ioreg";
const PMSET_PATH = "/usr/bin/pmset";

export type MacResourceProbe = () => string;

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

export function readMacIdleMs(
  runIoreg: MacResourceProbe = defaultIoreg,
  platform: NodeJS.Platform = process.platform
): number | undefined {
  if (platform !== "darwin") return undefined;
  try {
    const seconds = parseHidIdleSeconds(runIoreg());
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
    return parseOnAcPower(runPmset());
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

function defaultIoreg(): string {
  return execFileSync(IOREG_PATH, ["-c", "IOHIDSystem"], {
    encoding: "utf8",
    maxBuffer: MAC_IDLE_OUTPUT_LIMIT_BYTES,
    timeout: MAC_RESOURCE_PROBE_TIMEOUT_MS
  });
}

function defaultPmset(): string {
  return execFileSync(PMSET_PATH, ["-g", "batt"], {
    encoding: "utf8",
    maxBuffer: MAC_POWER_OUTPUT_LIMIT_BYTES,
    timeout: MAC_RESOURCE_PROBE_TIMEOUT_MS
  });
}
