import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerCostCommands, type CostCommandHelpers } from "./commands-cost.js";
import type { ProgramIO } from "./program.js";

// CLI command-parser + action-wiring smoke (backlog P5). `muse cost` builds the
// /api/admin/token-cost/* request path from options/args — the bug-prone part is
// the query-string assembly and the encodeURIComponent on the run id (an
// unencoded id with `&` / `=` would inject extra query params). Inject fake
// helpers so the test asserts the EXACT path the parser routes to, plus that the
// apiRequest result is handed to writeOutput, without any network.

const io: ProgramIO = { stderr: () => undefined, stdout: () => undefined };

const run = async (args: string[]): Promise<{ paths: string[]; written: unknown[]; exitCode: number | undefined }> => {
  const paths: string[] = [];
  const written: unknown[] = [];
  const helpers: CostCommandHelpers = {
    apiRequest: async (_io, _command, path) => { paths.push(path); return { rows: [], _path: path }; },
    writeOutput: (_io, value) => { written.push(value); },
  };
  const program = new Command();
  program.exitOverride();
  registerCostCommands(program, io, helpers);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["node", "muse", "cost", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  }
  return { exitCode, paths, written };
};

describe("muse cost — command parser + path wiring", () => {
  it("daily: no option → bare path; --days appends an encoded days query", async () => {
    expect((await run(["daily"])).paths).toEqual(["/api/admin/token-cost/daily"]);
    expect((await run(["daily", "--days", "30"])).paths).toEqual(["/api/admin/token-cost/daily?days=30"]);
  });

  it("top: builds the query string from --days + --limit (both, either, neither)", async () => {
    expect((await run(["top"])).paths).toEqual(["/api/admin/token-cost/top-expensive"]);
    expect((await run(["top", "--days", "14"])).paths).toEqual(["/api/admin/token-cost/top-expensive?days=14"]);
    expect((await run(["top", "--days", "14", "--limit", "5"])).paths).toEqual(["/api/admin/token-cost/top-expensive?days=14&limit=5"]);
    expect((await run(["top", "--limit", "5"])).paths).toEqual(["/api/admin/token-cost/top-expensive?limit=5"]);
  });

  it("for <run-id>: routes to by-session with the run id", async () => {
    expect((await run(["for", "run-123"])).paths).toEqual(["/api/admin/token-cost/by-session?runId=run-123"]);
  });

  it("for: encodeURIComponent prevents query-param injection via a hostile run id", async () => {
    const { paths } = await run(["for", "evil&admin=1 x"]);
    expect(paths).toEqual(["/api/admin/token-cost/by-session?runId=evil%26admin%3D1%20x"]);
    // the `&` and `=` are percent-encoded, so no extra param is smuggled in
    expect(paths[0]).not.toContain("admin=1");
  });

  it("hands the apiRequest result to writeOutput (the action wiring, not just the path)", async () => {
    const { written } = await run(["daily"]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ _path: "/api/admin/token-cost/daily" });
  });

  it("an unknown subcommand is rejected by the parser (exitOverride → non-zero)", async () => {
    const { exitCode } = await run(["bogus"]);
    expect(exitCode).not.toBe(0);
    expect(exitCode).toBeDefined();
  });

  it("`for` with no run-id argument is a parse error (required argument)", async () => {
    const { exitCode } = await run(["for"]);
    expect(exitCode).toBeDefined();
  });
});
