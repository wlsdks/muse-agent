import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerToolsAdminCommands, type ToolsAdminCommandHelpers } from "./commands-tools-admin.js";
import type { ProgramIO } from "./program.js";

// CLI command-parser + action-wiring smoke (backlog P5) for `muse tools` — the
// tool-usage observability group. Each subcommand routes to a fixed admin path;
// assert the EXACT path + that the apiRequest result is handed to writeOutput.
// Fake helpers, no network.

const io: ProgramIO = { stderr: () => undefined, stdout: () => undefined };

const run = async (args: string[]): Promise<{ paths: string[]; written: unknown[]; exitCode: number | undefined }> => {
  const paths: string[] = [];
  const written: unknown[] = [];
  const helpers: ToolsAdminCommandHelpers = {
    apiRequest: async (_io, _command, path) => { paths.push(path); return { _path: path }; },
    writeOutput: (_io, value) => { written.push(value); },
  };
  const program = new Command();
  program.exitOverride();
  registerToolsAdminCommands(program, io, helpers);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["node", "muse", "tools", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  }
  return { exitCode, paths, written };
};

describe("muse tools — command parser + path wiring", () => {
  it.each([
    ["stats", "/api/admin/tools/stats"],
    ["accuracy", "/api/admin/tools/accuracy"],
    ["calls", "/api/admin/tool-calls"],
    ["ranking", "/api/admin/tool-calls/ranking"],
  ])("%s routes to %s and hands the result to writeOutput", async (sub, path) => {
    const { paths, written } = await run([sub]);
    expect(paths).toEqual([path]);
    expect(written).toEqual([{ _path: path }]);
  });

  it("an unknown subcommand is a parse error", async () => {
    expect((await run(["bogus"])).exitCode).toBeDefined();
  });
});
