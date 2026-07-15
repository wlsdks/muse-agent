import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { setCliLanguage } from "./cli-i18n.js";
import {
  API_LAUNCH_AGENT_LABEL,
  buildApiLaunchAgentPlist,
  defaultRunLaunchctl,
  installApiAutostart,
  resolveApiLaunchAgentFile
} from "./commands-serve-launchagent.js";

import type { ProgramIO } from "./program.js";

setCliLanguage("en");

function freshIo(): { readonly io: ProgramIO; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stderr: (m) => stderr.push(m), stdout: (m) => stdout.push(m) }, stderr, stdout };
}

describe("buildApiLaunchAgentPlist", () => {
  it("emits Label/ProgramArguments/EnvironmentVariables/KeepAlive, with NO ProcessType throttle (unlike the daemon's plist)", () => {
    const plist = buildApiLaunchAgentPlist({
      environmentVariables: { HOST: "127.0.0.1", PORT: "3030" },
      label: "com.muse.api",
      programArguments: ["/usr/bin/node", "/repo/apps/api/dist/index.js"],
      stderrPath: "/home/x/.muse/logs/api.err.log",
      stdoutPath: "/home/x/.muse/logs/api.out.log"
    });
    expect(plist).toContain("<key>Label</key>\n  <string>com.muse.api</string>");
    expect(plist).toContain("<string>3030</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).not.toContain("ProcessType");
    expect(plist).not.toContain("LowPriorityIO");
  });
});

describe("resolveApiLaunchAgentFile", () => {
  it("honours MUSE_API_PLIST_FILE override; otherwise resolves under HOME/Library/LaunchAgents", () => {
    expect(resolveApiLaunchAgentFile({ MUSE_API_PLIST_FILE: "/tmp/custom.plist" })).toBe("/tmp/custom.plist");
    expect(resolveApiLaunchAgentFile({ HOME: "/Users/x" })).toBe("/Users/x/Library/LaunchAgents/com.muse.api.plist");
  });
});

describe("defaultRunLaunchctl", () => {
  it("refuses to exec real launchctl under vitest", async () => {
    await expect(defaultRunLaunchctl(["list", API_LAUNCH_AGENT_LABEL])).rejects.toThrow(/refusing to exec real launchctl/u);
  });
});

describe("installApiAutostart", () => {
  it("refuses on a non-darwin platform, writes nothing", async () => {
    const { io, stderr } = freshIo();
    const result = await installApiAutostart(io, {}, { distEntry: "/repo/apps/api/dist/index.js", host: "127.0.0.1", platform: "linux", port: 3030 });
    expect(result.ok).toBe(false);
    expect(stderr.join("")).toContain("only wired for macOS");
  });

  it("unloads stale, writes+loads the plist, and reports success once `list` confirms a PID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-serve-install-"));
    const plistFile = join(dir, "com.muse.api.plist");
    const env = { MUSE_API_PLIST_FILE: plistFile };
    const calls: (readonly string[])[] = [];
    const runLaunchctl = async (args: readonly string[]) => {
      calls.push(args);
      if (args[0] === "unload") return { code: 1, stderr: "Could not find specified service", stdout: "" };
      if (args[0] === "load") return { code: 0, stderr: "", stdout: "" };
      return { code: 0, stderr: "", stdout: '{\n\t"PID" = 777;\n\t"LastExitStatus" = 0;\n};\n' };
    };
    const { io, stdout } = freshIo();

    const result = await installApiAutostart(io, env, {
      distEntry: "/repo/apps/api/dist/index.js",
      host: "127.0.0.1",
      platform: "darwin",
      port: 4321,
      runLaunchctl
    });

    expect(result.ok).toBe(true);
    expect(stdout.join("")).toContain("pid 777");
    expect(existsSync(plistFile)).toBe(true);
    expect(calls[0]).toEqual(["unload", "-w", plistFile]);
    expect(calls[1]).toEqual(["load", "-w", plistFile]);
    expect(calls[2]).toEqual(["list", API_LAUNCH_AGENT_LABEL]);
  });

  it("reports failure (never success) when `list` shows no PID after load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-serve-install-fail-"));
    const plistFile = join(dir, "com.muse.api.plist");
    const env = { MUSE_API_PLIST_FILE: plistFile };
    const runLaunchctl = async (args: readonly string[]) => {
      if (args[0] === "load") return { code: 5, stderr: "Load failed: 5: Input/output error", stdout: "" };
      return { code: 1, stderr: "", stdout: "" };
    };
    const { io, stdout } = freshIo();

    const result = await installApiAutostart(io, env, {
      distEntry: "/repo/apps/api/dist/index.js",
      host: "127.0.0.1",
      platform: "darwin",
      port: 3030,
      runLaunchctl
    });

    expect(result.ok).toBe(false);
    expect(stdout.join("")).not.toContain("pid");
  });
});
