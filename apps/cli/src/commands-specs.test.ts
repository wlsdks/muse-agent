import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerSpecsCommands, type SpecsHelpers } from "./commands-specs.js";
import type { ProgramIO } from "./program.js";

// CLI command-parser + action-wiring smoke (backlog P5) for `muse specs` — the
// agent-spec registry surface (list / get / resolve). The wiring worth pinning:
// the get path encodes the name (no path injection/traversal via a hostile
// name), and resolve joins+trims the variadic prompt into a POST body and
// rejects an empty prompt. Fake helpers, no network.

const io: ProgramIO = { stderr: () => undefined, stdout: () => undefined };

const run = async (args: string[]): Promise<{
  calls: { path: string; body?: Record<string, unknown>; method?: string }[];
  written: unknown[];
  exitCode: number | undefined;
}> => {
  const calls: { path: string; body?: Record<string, unknown>; method?: string }[] = [];
  const written: unknown[] = [];
  const helpers: SpecsHelpers = {
    apiRequest: async (_io, _command, path, body, method) => { calls.push({ body, method, path }); return { _path: path }; },
    writeOutput: (_io, value) => { written.push(value); },
  };
  const program = new Command();
  program.exitOverride();
  registerSpecsCommands(program, io, helpers);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["node", "muse", "specs", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  }
  return { calls, exitCode, written };
};

describe("muse specs — command parser + path/body wiring", () => {
  it("list → GET /agent-specs, result handed to writeOutput", async () => {
    const { calls, written } = await run(["list"]);
    expect(calls).toEqual([{ body: undefined, method: undefined, path: "/agent-specs" }]);
    expect(written).toEqual([{ _path: "/agent-specs" }]);
  });

  it("get <name> → /agent-specs/<name>", async () => {
    expect((await run(["get", "researcher"])).calls[0]!.path).toBe("/agent-specs/researcher");
  });

  it("get encodes a hostile name — no path traversal / injection", async () => {
    expect((await run(["get", "../admin/secrets"])).calls[0]!.path).toBe("/agent-specs/..%2Fadmin%2Fsecrets");
    expect((await run(["get", "a b&x=1"])).calls[0]!.path).toBe("/agent-specs/a%20b%26x%3D1");
  });

  it("resolve <text...> → POST /agent-specs/resolve with the joined+trimmed prompt as the body", async () => {
    const { calls } = await run(["resolve", "  route", "this", "please  "]);
    expect(calls[0]).toEqual({ body: { text: "route this please" }, method: undefined, path: "/agent-specs/resolve" });
  });

  it("resolve with an all-whitespace prompt is rejected (non-empty guard), no request fires", async () => {
    const { calls, exitCode } = await run(["resolve", "   "]);
    expect(exitCode).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("an unknown subcommand and a missing required <name> are parse errors", async () => {
    expect((await run(["bogus"])).exitCode).toBeDefined();
    expect((await run(["get"])).exitCode).toBeDefined();
  });
});
