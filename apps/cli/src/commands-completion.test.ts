import { Command } from "commander";
import { describe, expect, it } from "vitest";

import {
  registerCalendarCommands,
  type CalendarCommandHelpers
} from "./commands-calendar.js";
import {
  collectSubcommandMap,
  collectTopLevelCommandNames,
  registerCompletionCommand,
  renderBashCompletion,
  renderZshCompletion
} from "./commands-completion.js";

function buildProgram(): Command {
  const stdout: string[] = [];
  const io = { stderr: () => {}, stdout: (line: string) => stdout.push(line) };
  const helpers: CalendarCommandHelpers = {
    apiRequest: async () => ({ events: [] }),
    writeOutput: () => {}
  };
  const program = new Command();
  program.exitOverride();
  registerCalendarCommands(program, io, helpers);
  registerCompletionCommand(program, io);
  return program;
}

describe("muse completion — second-level subcommand completion from the live tree", () => {
  it("collectSubcommandMap surfaces a group's real subcommands", () => {
    const map = collectSubcommandMap(buildProgram());
    const calendarSubs = map.get("calendar");
    expect(calendarSubs).toBeDefined();
    // The real registered calendar group — add/delete/edit/show are the
    // CRUD verbs a daily user tab-completes; assert they're enumerated.
    for (const sub of ["add", "delete", "edit", "show"]) {
      expect(calendarSubs).toContain(sub);
    }
  });

  it("collectSubcommandMap omits leaf commands (completion has no children)", () => {
    const map = collectSubcommandMap(buildProgram());
    expect(map.has("completion")).toBe(false);
  });

  it("bash script branches on the group word and lists its subcommands", () => {
    const program = buildProgram();
    const names = collectTopLevelCommandNames(program).filter((n) => n !== "completion");
    const script = renderBashCompletion(names, collectSubcommandMap(program));
    expect(script).toContain("COMP_CWORD\" -eq 2");
    expect(script).toContain("case \"${COMP_WORDS[1]}\" in");
    expect(script).toMatch(/calendar\) COMPREPLY=\(.*\badd\b.*\bedit\b.*\)/);
  });

  it("zsh script describes a group's subcommands at word 3", () => {
    const program = buildProgram();
    const names = collectTopLevelCommandNames(program).filter((n) => n !== "completion");
    const script = renderZshCompletion(names, collectSubcommandMap(program));
    expect(script).toContain("CURRENT == 3");
    expect(script).toContain("case \"${words[2]}\" in");
    expect(script).toMatch(/calendar\) local -a sc; sc=\(.*'add'.*'edit'.*\)/);
  });

  it("end-to-end: `muse completion bash` emits calendar's subcommands", async () => {
    const stdout: string[] = [];
    const io = { stderr: () => {}, stdout: (line: string) => stdout.push(line) };
    const helpers: CalendarCommandHelpers = {
      apiRequest: async () => ({ events: [] }),
      writeOutput: () => {}
    };
    const program = new Command();
    program.exitOverride();
    registerCalendarCommands(program, io, helpers);
    registerCompletionCommand(program, io);
    await program.parseAsync(["node", "muse", "completion", "bash"]);
    const out = stdout.join("");
    expect(out).toContain("calendar) COMPREPLY=(");
    expect(out).toContain("delete");
  });

  it("renders a safe empty second level when no group has subcommands", () => {
    const script = renderBashCompletion(["chat", "ask"]);
    // No case arms, but the structure + the catch-all must still be present
    // so the script is valid bash that completes nothing at word 2.
    expect(script).toContain("*) COMPREPLY=() ;;");
  });
});
