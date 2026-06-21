import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { COMMAND_GROUPS, applyCommandGroups } from "./command-groups.js";

const buildProgram = (names: readonly string[]) => {
  const program = new Command("muse");
  program.configureHelp({ sortSubcommands: true });
  for (const name of names) program.command(name).description(`do ${name}`);
  return program;
};

describe("applyCommandGroups", () => {
  it("renders curated headings in COMMAND_GROUPS order, ahead of the default group", () => {
    const program = buildProgram([
      "zzz-tail",
      "chat",
      "memory",
      "today",
      "setup",
      "proactive",
      "mcp",
      "read",
      "brief",
      "metrics",
      "another-tail"
    ]);
    applyCommandGroups(program);
    const help = program.helpInformation();

    const order = [
      "Chat & ask",
      "Memory & knowledge",
      "Planning & time",
      "Setup & status",
      "Automation & agents",
      "Connections",
      "Documents & analysis",
      "Reports & history",
      "Diagnostics",
      "Commands:"
    ];
    const positions = order.map((heading) => help.indexOf(heading));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
  });

  it("places a curated command under its heading and the tail under the default", () => {
    const program = buildProgram(["chat", "memory", "zzz-tail"]);
    applyCommandGroups(program);
    const help = program.helpInformation();

    const chatAt = help.indexOf("Chat & ask");
    const memAt = help.indexOf("Memory & knowledge");
    const tailAt = help.indexOf("Commands:");
    expect(help.indexOf("chat")).toBeGreaterThan(chatAt);
    expect(help.indexOf("chat")).toBeLessThan(memAt);
    expect(help.indexOf("zzz-tail")).toBeGreaterThan(tailAt);
  });

  it("never emits a heading for a group whose commands are all absent (fabrication 0)", () => {
    const program = buildProgram(["chat", "zzz-tail"]);
    applyCommandGroups(program);
    const help = program.helpInformation();

    expect(help).toContain("Chat & ask");
    expect(help).not.toContain("Memory & knowledge");
    expect(help).not.toContain("Planning & time");
  });

  it("only references real registered commands, never invents one", () => {
    const program = buildProgram(["chat"]);
    applyCommandGroups(program);
    const help = program.helpInformation();
    // "memory" is curated but not registered here — it must not appear.
    expect(help).not.toContain("do memory");
  });

  it("keeps every curated command name unique across groups", () => {
    const seen = new Set<string>();
    for (const group of COMMAND_GROUPS) {
      for (const name of group.commands) {
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
  });
});
