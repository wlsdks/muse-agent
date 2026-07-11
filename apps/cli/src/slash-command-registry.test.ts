import { describe, expect, it } from "vitest";

import { matchSlashCommands } from "./chat-ink-core.js";
import { SLASH_COMMAND_REGISTRY, slashCommandsForPlatform } from "./slash-command-registry.js";

const EXPECTED_CHAT_COMMANDS = [
  "help", "new", "clear", "model", "agents", "agent", "skills", "today", "tools",
  "job", "jobs", "orchestrate", "memory", "remember", "pref", "recall", "reflect",
  "forget", "trust", "persona", "history", "compact", "undo", "save", "copy",
  "cost", "exit"
];

describe("SLASH_COMMAND_REGISTRY", () => {
  it("has no duplicate command name", () => {
    const names = SLASH_COMMAND_REGISTRY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has no name/alias collision", () => {
    const seen = new Map<string, string>();
    for (const entry of SLASH_COMMAND_REGISTRY) {
      const tokens = [entry.name, ...(entry.aliases ?? [])];
      for (const token of tokens) {
        const owner = seen.get(token);
        if (owner && owner !== entry.name) {
          throw new Error(`collision: "${token}" claimed by both "${owner}" and "${entry.name}"`);
        }
        seen.set(token, entry.name);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("every entry has a valid category", () => {
    const validCategories = new Set(["session", "memory", "tools", "tasks", "knowledge", "info"]);
    for (const entry of SLASH_COMMAND_REGISTRY) {
      expect(validCategories.has(entry.category)).toBe(true);
    }
  });

  it("gates platform membership: chat-only command absent from cli, shared command present in both", () => {
    const chat = slashCommandsForPlatform("chat");
    const cli = slashCommandsForPlatform("cli");

    expect(chat.some((c) => c.cmd === "new")).toBe(true);
    expect(cli.some((c) => c.cmd === "new")).toBe(false);

    expect(chat.some((c) => c.cmd === "memory")).toBe(true);
    expect(cli.some((c) => c.cmd === "memory")).toBe(true);
  });

  it("preserves the exact chat command list (no behavior change)", () => {
    const chat = slashCommandsForPlatform("chat");
    expect(new Set(chat.map((c) => c.cmd))).toEqual(new Set(EXPECTED_CHAT_COMMANDS));
    expect(chat.length).toBe(EXPECTED_CHAT_COMMANDS.length);

    const byName = new Map(chat.map((c) => [c.cmd, c.desc]));
    expect(byName.get("help")).toBe("show command help");
    expect(byName.get("memory")).toBe("show what Muse remembers about you");
    expect(byName.get("undo")).toBe("roll back the last exchange — /undo <N> to roll back N (1-20)");
  });

  it("matchSlashCommands works off the derived chat list", () => {
    const chat = slashCommandsForPlatform("chat");

    const memMatches = matchSlashCommands("/mem", chat);
    expect(memMatches.some((c) => c.cmd === "memory")).toBe(true);

    const all = matchSlashCommands("/", chat);
    expect(all.length).toBe(chat.length);

    const none = matchSlashCommands("/xyzzy", chat);
    expect(none.length).toBe(0);
  });
});
