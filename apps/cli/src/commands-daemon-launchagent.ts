/**
 * macOS LaunchAgent (launchd) wiring for the resident `muse daemon`: the plist
 * builder + its install path. Split out of commands-daemon.ts; pure string/path
 * helpers, no daemon runtime state.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const LAUNCH_AGENT_LABEL = "com.muse.daemon";

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A macOS LaunchAgent plist that keeps `muse daemon` resident: it
// starts at login (RunAtLoad) and is restarted if it exits
// (KeepAlive), so the daemon survives logout / reboot. ProcessType
// Background marks it low-priority so macOS throttles its CPU/IO under
// contention — the OS-level complement to the brake-first idle gates
// (B1): background learning must never compete with the user's work.
export function buildLaunchAgentPlist(opts: {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly environmentVariables?: Readonly<Record<string, string>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}): string {
  const args = opts.programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const environmentEntries = Object.entries(opts.environmentVariables ?? {})
    .sort(([left], [right]) => left.localeCompare(right));
  const environment = environmentEntries.length === 0
    ? ""
    : `  <key>EnvironmentVariables</key>
  <dict>
${environmentEntries
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n")}
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${environment}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.stderrPath)}</string>
</dict>
</plist>
`;
}

export function resolveLaunchAgentFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_DAEMON_PLIST_FILE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const home = env.HOME?.trim()?.length ? env.HOME.trim() : homedir();
  return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export interface LaunchctlListInfo {
  /** Present + > 0 only when the job is RUNNING right now. */
  readonly pid?: number;
  /** Exit status of the job's most recent stop, when launchd reports one. */
  readonly lastExitStatus?: number;
}

/**
 * Parse `launchctl list <label>` output for a FOUND label. launchd prints an
 * NSDictionary-style dump (quoted keys, not JSON) — e.g. `"PID" = 1234;` and
 * `"LastExitStatus" = 0;` — never a simple exit code. A present PID means the
 * job is running now; its absence combined with a non-zero LastExitStatus
 * means launchd has the label registered but the job crashed or failed to
 * start (crash-looping) — the two states `list`'s own exit code alone can't
 * distinguish (both exit 0: registered proves nothing about actually running).
 */
export function parseLaunchctlListInfo(stdout: string): LaunchctlListInfo {
  const pidMatch = /"PID"\s*=\s*(\d+);/.exec(stdout);
  const statusMatch = /"LastExitStatus"\s*=\s*(-?\d+);/.exec(stdout);
  const pid = pidMatch ? Number(pidMatch[1]) : undefined;
  const lastExitStatus = statusMatch ? Number(statusMatch[1]) : undefined;
  return {
    ...(pid !== undefined && Number.isFinite(pid) && pid > 0 ? { pid } : {}),
    ...(lastExitStatus !== undefined && Number.isFinite(lastExitStatus) ? { lastExitStatus } : {})
  };
}
