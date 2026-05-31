/**
 * REAL OS-idle probe (macOS HID) for the background self-learning brake.
 *
 * The self-learning daemon must NOT work while the user is busy — but
 * `lastActivityMs` only sees Muse's own /api traffic, so it reports "idle"
 * exactly when the laptop is busiest in ANOTHER app (editing, compiling,
 * browsing). The OS HID idle time is the real signal: seconds since the last
 * keyboard/mouse event, system-wide. Read it from `ioreg -c IOHIDSystem`'s
 * `HIDIdleTime` (nanoseconds). FAIL-CLOSED: any parse/exec error or a
 * non-macOS host returns `undefined`, which the gate treats as "not idle" —
 * we never run an unattended LLM job without positive evidence the machine
 * is quiet. (PART A2 / B1 brake-and-proof-first.)
 */
import { execFileSync } from "node:child_process";

/**
 * Parse the system-wide idle SECONDS from `ioreg -c IOHIDSystem` output.
 * `HIDIdleTime` is nanoseconds since the last HID event. Returns undefined
 * when the field is absent or unparseable (fail-closed). Pure → testable.
 */
export function parseHidIdleSeconds(ioregOutput: string): number | undefined {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/u.exec(ioregOutput);
  if (!match) {
    return undefined;
  }
  const nanos = Number(match[1]);
  if (!Number.isFinite(nanos) || nanos < 0) {
    return undefined;
  }
  return nanos / 1e9;
}

/**
 * System-wide OS idle time in MILLISECONDS, or undefined when it can't be
 * determined (non-macOS, ioreg missing, parse failure) — fail-closed. The
 * `runIoreg` seam lets tests inject output without shelling out.
 */
export function osIdleMs(runIoreg: () => string = defaultIoreg): number | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  let output: string;
  try {
    output = runIoreg();
  } catch {
    return undefined;
  }
  const seconds = parseHidIdleSeconds(output);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

function defaultIoreg(): string {
  return execFileSync("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8", timeout: 5000 });
}

/**
 * Brake predicate: true only when the OS has been idle at least
 * `thresholdMs`. An UNKNOWN idle time (undefined) is treated as NOT idle —
 * fail-closed, so an unattended LLM job never fires without proof of quiet.
 */
export function isOsIdleEnough(osIdle: number | undefined, thresholdMs: number): boolean {
  return osIdle !== undefined && osIdle >= thresholdMs;
}
