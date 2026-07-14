import { describe, expect, it } from "vitest";

import { COMMAND_STUBS } from "./command-manifest.js";
import { SLASH_COMMAND_REGISTRY, slashCommandsForPlatform } from "./slash-command-registry.js";

const REAL_CLI_NAMES = new Set(COMMAND_STUBS.map((stub) => stub.name));

const EXPECTED_CHAT_COMMANDS = [
  "help", "new", "clear", "model", "agents", "agent", "skills", "today", "tools",
  "job", "jobs", "orchestrate", "memory", "remember", "pref", "recall", "reflect",
  "forget", "trust", "persona", "history", "sessions", "resume", "compact", "undo",
  "save", "copy", "cost", "exit"
];

describe("slash-command-registry CLI-surface drift", () => {
  it("every cli-tagged registry entry names a real `muse <name>` command", () => {
    for (const entry of SLASH_COMMAND_REGISTRY) {
      if (!entry.platforms.includes("cli")) continue;
      const resolved = entry.cliName ?? entry.name;
      expect(REAL_CLI_NAMES.has(resolved), `"${entry.name}" claims CLI command "${resolved}" but no such command exists in COMMAND_STUBS`).toBe(true);
    }
  });

  it("every cmd projected by slashCommandsForPlatform(\"cli\") is a real CLI command", () => {
    const cli = slashCommandsForPlatform("cli");
    for (const { cmd } of cli) {
      expect(REAL_CLI_NAMES.has(cmd), `projected CLI cmd "${cmd}" is not a real command`).toBe(true);
    }
  });

  it("reflect projects to the real CLI command reflections, never to reflect", () => {
    const cli = slashCommandsForPlatform("cli");
    expect(cli.some((c) => c.cmd === "reflections")).toBe(true);
    expect(cli.some((c) => c.cmd === "reflect")).toBe(false);
  });

  it("chat surface is 29 commands, including /sessions + /resume, jobs, pref, reflect", () => {
    const chat = slashCommandsForPlatform("chat");
    expect(chat.length).toBe(29);
    expect(new Set(chat.map((c) => c.cmd))).toEqual(new Set(EXPECTED_CHAT_COMMANDS));
    expect(chat.some((c) => c.cmd === "jobs")).toBe(true);
    expect(chat.some((c) => c.cmd === "pref")).toBe(true);
    expect(chat.some((c) => c.cmd === "reflect")).toBe(true);
    expect(chat.some((c) => c.cmd === "sessions")).toBe(true);
    expect(chat.some((c) => c.cmd === "resume")).toBe(true);
  });
});
