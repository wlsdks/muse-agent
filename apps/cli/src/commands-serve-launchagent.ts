/**
 * macOS LaunchAgent wiring for `muse serve --install` — the API-server
 * counterpart of commands-daemon-launchagent.ts. A SEPARATE plist/label
 * (`com.muse.api`, not `com.muse.daemon`): the daemon and the API server
 * are independently start/stoppable services. Deliberately does NOT reuse
 * commands-daemon-launchagent.ts's `buildLaunchAgentPlist` — that builder
 * hardcodes `ProcessType: Background` + `LowPriorityIO` to keep background
 * LEARNING ticks off the user's CPU/IO, but this process answers live
 * chat/API requests, so it must run at normal priority.
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { t } from "./cli-i18n.js";
import { parseLaunchctlListInfo } from "./commands-daemon-launchagent.js";

import type { ProgramIO } from "./program.js";

const execFile = promisify(execFileCallback);

export const API_LAUNCH_AGENT_LABEL = "com.muse.api";

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildApiLaunchAgentPlist(opts: {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}): string {
  const args = opts.programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(opts.environmentVariables)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
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
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.stderrPath)}</string>
</dict>
</plist>
`;
}

export function resolveApiLaunchAgentFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_API_PLIST_FILE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const home = env.HOME?.trim()?.length ? env.HOME.trim() : homedir();
  return join(home, "Library", "LaunchAgents", `${API_LAUNCH_AGENT_LABEL}.plist`);
}

function isRunningUnderVitest(): boolean {
  return (process.env.VITEST ?? "").trim().length > 0 || process.env.VITEST_WORKER_ID !== undefined;
}

/**
 * NEVER reaches real launchctl under vitest, even if a test forgets to
 * inject a runner — loading a real LaunchAgent from a test run would leave
 * a KeepAlive server resident on the contributor's machine.
 */
export const defaultRunLaunchctl = async (args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
  if (isRunningUnderVitest()) {
    throw new Error(
      `refusing to exec real launchctl under vitest (args: ${args.join(" ")}) — inject runLaunchctl in this test`
    );
  }
  try {
    const result = await execFile("launchctl", [...args], { timeout: 15_000 });
    return { code: 0, stderr: result.stderr.toString(), stdout: result.stdout.toString() };
  } catch (cause: unknown) {
    const rawCode = (cause as { readonly code?: number | string } | undefined)?.code;
    const code = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" ? Number(rawCode) || 1 : 1;
    const out = (key: "stdout" | "stderr"): string => {
      const value = cause && typeof cause === "object" && key in cause
        ? (cause as Record<"stdout" | "stderr", string | Buffer | undefined>)[key]
        : undefined;
      return value?.toString() ?? "";
    };
    return { code, stderr: out("stderr"), stdout: out("stdout") };
  }
};

export interface InstallApiAutostartOptions {
  readonly distEntry: string;
  readonly port: number;
  readonly host: string;
  readonly platform?: NodeJS.Platform;
  readonly runLaunchctl?: (args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

/**
 * Write + load the API-server LaunchAgent. Returns `{ok:false}` (never
 * throws) on every failure branch, including an unsupported platform.
 * `list`'s own PID (not `load`'s exit code) is the source of truth for
 * "actually running" — mirrors `installDaemonAutostart`'s verification.
 */
export async function installApiAutostart(
  io: ProgramIO,
  env: NodeJS.ProcessEnv,
  opts: InstallApiAutostartOptions
): Promise<{ readonly ok: boolean }> {
  const plat = opts.platform ?? process.platform;
  if (plat !== "darwin") {
    io.stderr(t("serve.install.platformUnsupported", { platform: plat }));
    return { ok: false };
  }
  const plistFile = resolveApiLaunchAgentFile(env);
  const home = env.HOME?.trim()?.length ? env.HOME.trim() : homedir();
  const logDir = join(home, ".muse", "logs");
  const plist = buildApiLaunchAgentPlist({
    environmentVariables: { HOST: opts.host, PORT: String(opts.port) },
    label: API_LAUNCH_AGENT_LABEL,
    programArguments: [process.execPath, opts.distEntry],
    stderrPath: join(logDir, "api.err.log"),
    stdoutPath: join(logDir, "api.out.log")
  });

  const runLaunchctl = opts.runLaunchctl ?? defaultRunLaunchctl;

  // Unload any stale definition first — `load -w` is not reliably
  // idempotent for an already-loaded label (same rationale as the daemon's
  // installer). A failed unload here (nothing was loaded yet) is expected.
  await runLaunchctl(["unload", "-w", plistFile]);

  mkdirSync(dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, plist, "utf8");

  const loadResult = await runLaunchctl(["load", "-w", plistFile]);
  const listResult = await runLaunchctl(["list", API_LAUNCH_AGENT_LABEL]);
  const { pid } = parseLaunchctlListInfo(listResult.stdout);

  if (listResult.code === 0 && pid !== undefined) {
    io.stdout(t("serve.install.written", { label: API_LAUNCH_AGENT_LABEL, logDir, pid: String(pid), plistFile }));
    return { ok: true };
  }

  io.stderr(t("serve.install.failed", {
    detail: loadResult.stderr.trim() || loadResult.stdout.trim() || listResult.stderr.trim() || "label not confirmed running after load",
    plistFile
  }));
  return { ok: false };
}
