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
  readonly stdoutPath: string;
  readonly stderrPath: string;
}): string {
  const args = opts.programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
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
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
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
