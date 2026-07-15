import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordProactiveHeartbeat } from "@muse/stores";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { resetCliContext, setCliContext } from "./cli-context.js";
import { registerSetupBriefingCommand, type SetupBriefingHelpers } from "./commands-setup-briefing.js";
import { SCHEDULER_ADD_DAEMON_STALE_MS } from "./commands-scheduler-setup.js";
import type { ProgramIO } from "./program.js";

function tmpConfigFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-setup-briefing-")), "daemon.json");
}

async function runBriefing(
  args: readonly string[],
  configFile: string,
  seam: Partial<SetupBriefingHelpers> = {}
): Promise<{ readonly out: string; readonly err: string; readonly exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stderr: (m: string) => err.push(m), stdout: (m: string) => out.push(m) } as unknown as ProgramIO;
  const helpers: SetupBriefingHelpers = {
    env: () => ({ MUSE_DAEMON_CONFIG_FILE: configFile } as NodeJS.ProcessEnv),
    heartbeatDir: mkdtempSync(join(tmpdir(), "muse-setup-briefing-hb-")),
    ...seam
  };
  const program = new Command("muse");
  program.exitOverride();
  program.command("setup").description("setup");
  registerSetupBriefingCommand(program, io, helpers);
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(["node", "muse", "setup", "briefing", ...args]);
  } catch {
    /* exitOverride throws on a commander-level error; the assertions below read stderr/exitCode */
  }
  const exitCode = process.exitCode;
  process.exitCode = priorExitCode;
  return { err: err.join(""), exitCode, out: out.join("") };
}

function readConfig(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("muse setup briefing — current state + writes", () => {
  it("shows disabled-by-default state and enables at the given --time", async () => {
    const configFile = tmpConfigFile();
    const { out } = await runBriefing(["--time", "07:15"], configFile);
    expect(out).toContain("Daily brief: disabled");
    expect(out).toContain("Daily brief enabled at 07:15");
    expect(readConfig(configFile)).toMatchObject({ dailyBrief: { enabled: true, time: "07:15" } });
  });

  it("is idempotent — re-running with a new --time updates the time in place", async () => {
    const configFile = tmpConfigFile();
    await runBriefing(["--time", "07:15"], configFile);
    const second = await runBriefing(["--time", "20:00"], configFile);
    expect(second.out).toContain("Daily brief: enabled at 07:15");
    expect(readConfig(configFile)).toMatchObject({ dailyBrief: { enabled: true, time: "20:00" } });
  });

  it("preserves the FILE-persisted provider/destination (from `muse daemon --init`) when only the time changes", async () => {
    const configFile = tmpConfigFile();
    // Simulates a prior `muse daemon --init` having already persisted provider/destination.
    writeFileSync(configFile, JSON.stringify({ destination: "555", provider: "telegram" }), "utf8");
    await runBriefing(["--time", "20:00"], configFile);
    // The write MERGES over the file's existing values — it never clobbers
    // what `muse daemon --init` already persisted.
    expect(readConfig(configFile)).toMatchObject({ dailyBrief: { time: "20:00" }, destination: "555", provider: "telegram" });
  });

  it("--off disables but keeps the configured time for next time", async () => {
    const configFile = tmpConfigFile();
    await runBriefing(["--time", "07:15"], configFile);
    const off = await runBriefing(["--off"], configFile);
    expect(off.out).toContain("Daily brief disabled (time kept: 07:15)");
    expect(readConfig(configFile)).toMatchObject({ dailyBrief: { enabled: false, time: "07:15" } });
    // --off is a status change, not a daemon-liveness question — no warning noise.
    expect(off.out).not.toContain("WARNING");
    expect(off.out).not.toContain("Daemon alive");
  });
});

describe("muse setup briefing — time validation (fail-closed)", () => {
  it("rejects an out-of-range time ('25:00') and writes nothing", async () => {
    const configFile = tmpConfigFile();
    const { err, exitCode } = await runBriefing(["--time", "25:00"], configFile);
    expect(exitCode).toBe(1);
    expect(err).toMatch(/HH:MM/);
    expect(() => readConfig(configFile)).toThrow();
  });

  it("rejects a 12-hour form ('9am')", async () => {
    const configFile = tmpConfigFile();
    const { err, exitCode } = await runBriefing(["--time", "9am"], configFile);
    expect(exitCode).toBe(1);
    expect(err).toMatch(/HH:MM/);
  });
});

describe("muse setup briefing — non-interactive / --no-input never blocks", () => {
  afterEach(() => {
    resetCliContext();
  });

  it("under --no-input with no --time flag, uses the default 08:30 without prompting", async () => {
    setCliContext({ noColor: false, noInput: true, quiet: false });
    const configFile = tmpConfigFile();
    let promptCalled = false;
    const { out } = await runBriefing([], configFile, {
      promptTime: async (defaultValue) => { promptCalled = true; return defaultValue; }
    });
    expect(promptCalled).toBe(false);
    expect(out).toContain("Daily brief enabled at 08:30");
  });

  it("a cancelled interactive prompt makes no change", async () => {
    const configFile = tmpConfigFile();
    const { out } = await runBriefing([], configFile, {
      promptTime: async () => undefined
    });
    expect(out).toContain("Cancelled — no changes made.");
    expect(() => readConfig(configFile)).toThrow();
  });

  it("the interactive prompt is offered the CURRENT time as its default", async () => {
    const configFile = tmpConfigFile();
    await runBriefing(["--time", "06:45"], configFile);
    let offeredDefault: string | undefined;
    await runBriefing([], configFile, {
      promptTime: async (defaultValue) => { offeredDefault = defaultValue; return defaultValue; }
    });
    expect(offeredDefault).toBe("06:45");
  });
});

describe("muse setup briefing — daemon-liveness check (R2-1 reuse)", () => {
  it("fresh daemon-loop heartbeat → quiet confirmation, no warning", async () => {
    const configFile = tmpConfigFile();
    const hbDir = mkdtempSync(join(tmpdir(), "muse-setup-briefing-hb-fresh-"));
    await recordProactiveHeartbeat(hbDir, "daemon-loop", () => new Date("2026-07-01T09:59:30Z"));
    const { out } = await runBriefing(["--time", "08:30"], configFile, {
      heartbeatDir: hbDir,
      now: () => new Date("2026-07-01T10:00:00Z")
    });
    expect(out).toContain("Daemon alive");
    expect(out).not.toContain("WARNING");
  });

  it("stale/absent daemon-loop heartbeat → bilingual warning naming `muse daemon --install`", async () => {
    const configFile = tmpConfigFile();
    const hbDir = mkdtempSync(join(tmpdir(), "muse-setup-briefing-hb-stale-"));
    const now = new Date("2026-07-01T10:00:00Z");
    await recordProactiveHeartbeat(hbDir, "daemon-loop", () => new Date(now.getTime() - SCHEDULER_ADD_DAEMON_STALE_MS - 1_000));
    const { out } = await runBriefing(["--time", "08:30"], configFile, { heartbeatDir: hbDir, now: () => now });
    expect(out).toContain("WARNING");
    expect(out).toContain("muse daemon --install");
    expect(out).toContain("경고");
  });
});
