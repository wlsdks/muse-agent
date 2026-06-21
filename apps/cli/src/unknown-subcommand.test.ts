import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { attachUnknownSubcommandGuidance, formatUnknownSubcommand } from "./unknown-subcommand.js";

describe("formatUnknownSubcommand", () => {
  it("names the group + attempted, suggests the closest real sub, and lists available", () => {
    const out = formatUnknownSubcommand("memory", "serch", ["forget", "search", "show"]);
    expect(out).toContain("error: unknown command 'muse memory serch'");
    expect(out).toContain("Did you mean 'muse memory search'?");
    expect(out).toContain("Available memory commands: forget, search, show");
  });

  it("falls back to a unique prefix when no close Levenshtein match", () => {
    const out = formatUnknownSubcommand("remind", "sno", ["add", "list", "snooze"]);
    expect(out).toContain("Did you mean 'muse remind snooze'?");
  });

  it("stays silent on an ambiguous prefix but still lists the real subcommands", () => {
    const out = formatUnknownSubcommand("memory", "s", ["search", "show"]);
    expect(out).not.toContain("Did you mean");
    expect(out).toContain("Available memory commands: search, show");
  });

  it("only names subcommands from the grounded registry (no fabrication)", () => {
    const out = formatUnknownSubcommand("remind", "bogus", ["add", "list"]);
    expect(out).not.toContain("show");
    expect(out).toContain("Available remind commands: add, list");
  });
});

describe("attachUnknownSubcommandGuidance", () => {
  const buildProgram = () => {
    const errs: string[] = [];
    const program = new Command("muse");
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    const group = program.command("memory");
    group.command("show").action(() => {});
    group.command("search").action(() => {});
    attachUnknownSubcommandGuidance(program, (text) => errs.push(text));
    return { errs, program };
  };

  it("prints the grounded block for a typo'd subcommand instead of the stock error", () => {
    const { errs, program } = buildProgram();
    program.parse(["node", "muse", "memory", "serch"], { from: "node" });
    const out = errs.join("");
    expect(out).toContain("Did you mean 'muse memory search'?");
    expect(out).toContain("Available memory commands: search, show");
  });

  it("does not fire for a valid subcommand", () => {
    const { errs, program } = buildProgram();
    program.parse(["node", "muse", "memory", "show"], { from: "node" });
    expect(errs.join("")).toBe("");
  });
});
