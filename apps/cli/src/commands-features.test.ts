import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerFeaturesCommand, renderFeatures } from "./commands-features.js";
import { FEATURE_REGISTRY } from "./feature-registry.js";
import type { ProgramIO } from "./program.js";

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: ProgramIO = { stderr: (m) => stderr.push(m), stdout: (m) => stdout.push(m) };
  const program = new Command();
  program.exitOverride();
  registerFeaturesCommand(program, io);
  await program.parseAsync(["node", "muse", "features", ...args]);
  return { stderr: stderr.join(""), stdout: stdout.join("") };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("registerFeaturesCommand", () => {
  it("registers a `features` command with a --json option and the expected description", () => {
    const program = new Command();
    registerFeaturesCommand(program, { stderr: () => undefined, stdout: () => undefined });
    const command = program.commands.find((c) => c.name() === "features");
    expect(command).toBeDefined();
    expect(command!.description()).toBe("Discover hidden capabilities that ship OFF by default, with the exact env var to enable each");
    expect(command!.options.some((o) => o.long === "--json")).toBe(true);
  });

  it("--json prints all 11 tier-1 entries with the flag-derived enabled booleans", async () => {
    vi.stubEnv("MUSE_CHAT_WRITE_ENABLED", "true");
    const { stdout } = await run(["--json"]);
    const payload = JSON.parse(stdout) as ReadonlyArray<{ entry: { envVar: string }; enabled: boolean }>;
    expect(payload.length).toBe(FEATURE_REGISTRY.length);
    for (const envVar of FEATURE_REGISTRY.map((entry) => entry.envVar)) {
      expect(payload.some((status) => status.entry.envVar === envVar)).toBe(true);
    }
    const chatWrite = payload.find((status) => status.entry.envVar === "MUSE_CHAT_WRITE_ENABLED")!;
    expect(chatWrite.enabled).toBe(true);
    const macActuators = payload.find((status) => status.entry.envVar === "MUSE_MACOS_ACTUATORS")!;
    expect(macActuators.enabled).toBe(false);
  });

  it("text output shows a checkmark for an ON feature", async () => {
    vi.stubEnv("MUSE_CHAT_WRITE_ENABLED", "true");
    const { stdout } = await run([]);
    expect(stdout).toContain("✅ Chat write tools");
  });
});

describe("renderFeatures", () => {
  it("an OFF feature's text includes its envVar and enable hint", () => {
    const entry = FEATURE_REGISTRY[0]!;
    const out = renderFeatures([{ enabled: false, entry }]);
    expect(out).toContain(entry.envVar);
    expect(out).toContain(entry.enableHint);
    expect(out).toContain(entry.unlocks);
  });

  it("an ON feature's text omits the enable hint and shows a checkmark", () => {
    const entry = FEATURE_REGISTRY[0]!;
    const out = renderFeatures([{ enabled: true, entry }]);
    expect(out).toContain("✅");
    expect(out).not.toContain(entry.enableHint);
  });

  it("prerequisites render as notes when present", () => {
    const entry = FEATURE_REGISTRY.find((e) => (e.prerequisites?.length ?? 0) > 0)!;
    const out = renderFeatures([{ enabled: false, entry }]);
    for (const prerequisite of entry.prerequisites ?? []) {
      expect(out).toContain(prerequisite);
    }
  });
});
