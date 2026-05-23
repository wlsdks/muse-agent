import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerConfigCommands, type MuseCliConfigShape } from "./commands-config.js";
import { unsetConfigValue } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

function buildHarness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: ProgramIO = {
    stdout: (m: string) => stdout.push(m),
    stderr: (m: string) => stderr.push(m)
  } as unknown as ProgramIO;
  let store: MuseCliConfigShape = {};
  const helpers = {
    readConfigStore: async (): Promise<MuseCliConfigShape> => store,
    writeConfigStore: async (_io: ProgramIO, next: MuseCliConfigShape): Promise<void> => {
      store = next;
    },
    setConfigValue: (config: MuseCliConfigShape, key: string, value: string): MuseCliConfigShape => {
      if (key !== "apiUrl" && key !== "defaultModel") throw new Error(`Unsupported config key '${key}'`);
      return { ...config, [key]: value.trim() };
    },
    unsetConfigValue,
    writeOutput: (_io: ProgramIO, value: unknown): void => {
      stdout.push(`${JSON.stringify(value)}\n`);
    }
  };
  return { helpers, io, stdout, stderr, peek: (): MuseCliConfigShape => store };
}

describe("muse config set --json", () => {
  it("emits a { key, value } envelope and writes the value to the store", async () => {
    const h = buildHarness();
    const program = new Command();
    registerConfigCommands(program, h.io, h.helpers);
    await program.parseAsync(
      ["node", "muse", "config", "set", "apiUrl", "http://api.test", "--json"],
      { from: "node" }
    );
    const parsed = JSON.parse(h.stdout.join("")) as { key: string; value: string };
    expect(parsed).toEqual({ key: "apiUrl", value: "http://api.test" });
    expect(h.peek().apiUrl).toBe("http://api.test");
    // The legacy `Set apiUrl` line must NOT also emit in --json mode.
    expect(h.stdout.join(""), "json mode must NOT emit the human-readable 'Set <key>' line").not.toContain("Set apiUrl");
  });

  it("trims surrounding whitespace from the value in the envelope (matches setConfigValue's normalisation)", async () => {
    const h = buildHarness();
    const program = new Command();
    registerConfigCommands(program, h.io, h.helpers);
    await program.parseAsync(
      ["node", "muse", "config", "set", "defaultModel", "  ollama/qwen3:8b  ", "--json"],
      { from: "node" }
    );
    const parsed = JSON.parse(h.stdout.join("")) as { key: string; value: string };
    expect(parsed.value, "envelope must echo the trimmed value, matching what was persisted").toBe("ollama/qwen3:8b");
    expect(h.peek().defaultModel).toBe("ollama/qwen3:8b");
  });

  it("keeps the legacy `Set <key>` output when --json is omitted", async () => {
    const h = buildHarness();
    const program = new Command();
    registerConfigCommands(program, h.io, h.helpers);
    await program.parseAsync(
      ["node", "muse", "config", "set", "apiUrl", "http://api.test"],
      { from: "node" }
    );
    expect(h.stdout.join("")).toBe("Set apiUrl\n");
  });
});

describe("muse config unset — set's inverse, clears a value back to the default", () => {
  it("set then unset removes the key from the store and confirms", async () => {
    const h = buildHarness();
    const program = new Command();
    registerConfigCommands(program, h.io, h.helpers);
    await program.parseAsync(["node", "muse", "config", "set", "apiUrl", "http://api.test"], { from: "node" });
    await program.parseAsync(["node", "muse", "config", "unset", "apiUrl"], { from: "node" });
    expect(h.peek().apiUrl).toBeUndefined();
    expect(h.stdout.join("")).toContain("Unset apiUrl");
  });

  it("unset of a never-set key reports `was not set` (no false success)", async () => {
    const h = buildHarness();
    const program = new Command();
    registerConfigCommands(program, h.io, h.helpers);
    await program.parseAsync(["node", "muse", "config", "unset", "defaultModel"], { from: "node" });
    expect(h.stdout.join("")).toContain("defaultModel was not set");
  });

  it("--json emits a { key, wasSet } envelope", async () => {
    const h = buildHarness();
    const program = new Command();
    registerConfigCommands(program, h.io, h.helpers);
    await program.parseAsync(["node", "muse", "config", "set", "defaultModel", "qwen3:8b"], { from: "node" });
    await program.parseAsync(["node", "muse", "config", "unset", "defaultModel", "--json"], { from: "node" });
    const out = h.stdout.join("");
    const parsed = JSON.parse(out.slice(out.indexOf("{"))) as { key: string; wasSet: boolean };
    expect(parsed).toEqual({ key: "defaultModel", wasSet: true });
  });
});
