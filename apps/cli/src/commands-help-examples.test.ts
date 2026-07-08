import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerAskCommand } from "./commands-ask.js";
import { registerMcpCommands, type McpHelpers } from "./commands-mcp.js";
import { registerMemoryCommands, type MemoryCommandHelpers } from "./commands-memory.js";
import { registerRememberCommands } from "./commands-remember.js";
import { registerSetupCommands } from "./commands-scheduler-setup.js";
import { registerSetupCloudCommand, type SetupCloudHelpers } from "./commands-setup-cloud.js";
import { registerSetupDataCommand } from "./commands-setup-data.js";
import { registerSkillsCommands } from "./commands-skills.js";
import { registerTodayCommands, type TodayCommandHelpers } from "./commands-today.js";
import { registerIngestCommand } from "./chat-export-ingest.js";
import type { ProgramIO } from "./program.js";

const io = { stderr: () => undefined, stdout: () => undefined } as unknown as ProgramIO;

/** Render a command's full help text (INCLUDING addHelpText("after") blocks). */
function helpFor(program: Command, path: readonly string[]): string {
  let cmd: Command = program;
  for (const seg of path) {
    const next = cmd.commands.find((c) => c.name() === seg);
    if (!next) throw new Error(`command not found: ${path.join(" ")} (missing '${seg}')`);
    cmd = next;
  }
  let buf = "";
  cmd.configureOutput({ writeErr: (s) => { buf += s; }, writeOut: (s) => { buf += s; } });
  cmd.outputHelp();
  return buf;
}

interface HelpCase {
  readonly name: string;
  readonly register: (program: Command) => void;
  readonly path: readonly string[];
  /** Substrings the Examples block MUST contain — real flags/subcommands only. */
  readonly mustContain: readonly string[];
}

const cases: readonly HelpCase[] = [
  {
    mustContain: ["muse ask ", "--scope work", "--why", "--image receipt.jpg --auto"],
    name: "ask",
    path: ["ask"],
    register: (p) => registerAskCommand(p, io)
  },
  {
    mustContain: ["muse today", "--brief", "--speak"],
    name: "today",
    path: ["today"],
    register: (p) => registerTodayCommands(p, io, {} as unknown as TodayCommandHelpers)
  },
  {
    mustContain: ["muse remember ", "--json", "muse forget home_city"],
    name: "remember",
    path: ["remember"],
    register: (p) => registerRememberCommands(p, io)
  },
  {
    mustContain: ["muse forget home_city", "--all --force"],
    name: "forget",
    path: ["forget"],
    register: (p) => registerRememberCommands(p, io)
  },
  {
    mustContain: ["muse memory show", "muse memory search", "muse memory forget"],
    name: "memory",
    path: ["memory"],
    register: (p) => registerMemoryCommands(p, io, {} as unknown as MemoryCommandHelpers)
  },
  {
    mustContain: ["muse skills list", "muse skills add", "--description", "muse skills author"],
    name: "skills",
    path: ["skills"],
    register: (p) => registerSkillsCommands(p, io)
  },
  {
    mustContain: ["muse mcp add", "--transport stdio", "--config", "muse mcp call", "--args", "muse mcp config-doctor"],
    name: "mcp",
    path: ["mcp"],
    register: (p) => registerMcpCommands(p, io, {} as unknown as McpHelpers)
  },
  {
    mustContain: ["muse ingest conversations.json", ".mbox", "--out"],
    name: "ingest",
    path: ["ingest"],
    register: (p) => registerIngestCommand(p, io)
  },
  {
    mustContain: ["muse setup", "muse setup start", "muse setup data", "muse setup cloud --provider gemini"],
    name: "setup",
    path: ["setup"],
    register: (p) => registerSetupCommands(p, io)
  },
  {
    mustContain: ["muse setup cloud --provider gemini", "--check", "--model"],
    name: "setup cloud",
    path: ["setup", "cloud"],
    register: (p) => {
      registerSetupCommands(p, io);
      registerSetupCloudCommand(p, io, { readConfigStore: async () => ({}), writeConfigStore: async () => undefined } as unknown as SetupCloudHelpers);
    }
  },
  {
    mustContain: ["muse setup data", "--contacts", "--browsing"],
    name: "setup data",
    path: ["setup", "data"],
    register: (p) => { registerSetupCommands(p, io); registerSetupDataCommand(p, io); }
  }
];

describe("daily-driver commands ship an examples-first help block", () => {
  for (const c of cases) {
    it(`${c.name} --help leads with a copy-pasteable Examples block using real flags`, () => {
      const program = new Command();
      c.register(program);
      const help = helpFor(program, c.path);
      expect(help).toContain("Examples:");
      for (const needle of c.mustContain) {
        expect(help, `expected \`${c.name}\` help to reference: ${needle}`).toContain(needle);
      }
    });
  }
});
