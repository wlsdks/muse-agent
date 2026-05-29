import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerAnalyticsCommands, type AnalyticsCommandHelpers } from "./commands-analytics.js";
import { registerLatencyCommands } from "./commands-latency.js";
import type { ProgramIO } from "./program.js";

// CLI command-parser + action-wiring smoke (backlog P5) for the sibling
// observability groups `muse latency` + `muse analytics`. Both wrap admin
// read-only surfaces; the parser must route each subcommand to the EXACT path
// (with the encoded --days query where present) and hand the apiRequest result
// to writeOutput. Fake helpers, no network.

const io: ProgramIO = { stderr: () => undefined, stdout: () => undefined };

const runGroup = async (
  register: (program: Command, io: ProgramIO, helpers: { apiRequest: AnalyticsCommandHelpers["apiRequest"]; writeOutput: AnalyticsCommandHelpers["writeOutput"] }) => void,
  group: string,
  args: string[],
): Promise<{ paths: string[]; written: unknown[]; exitCode: number | undefined }> => {
  const paths: string[] = [];
  const written: unknown[] = [];
  const helpers = {
    apiRequest: async (_io: ProgramIO, _command: Command, path: string) => { paths.push(path); return { _path: path }; },
    writeOutput: (_io: ProgramIO, value: unknown) => { written.push(value); },
  };
  const program = new Command();
  program.exitOverride();
  register(program, io, helpers);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["node", "muse", group, ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  }
  return { exitCode, paths, written };
};

describe("muse latency — command parser + path wiring", () => {
  const run = (args: string[]) => runGroup(registerLatencyCommands as never, "latency", args);

  it("summary / timeseries route to the right path; --days appends an encoded query", async () => {
    expect((await run(["summary"])).paths).toEqual(["/api/admin/metrics/latency/summary"]);
    expect((await run(["summary", "--days", "30"])).paths).toEqual(["/api/admin/metrics/latency/summary?days=30"]);
    expect((await run(["timeseries"])).paths).toEqual(["/api/admin/metrics/latency/timeseries"]);
    expect((await run(["timeseries", "--days", "14"])).paths).toEqual(["/api/admin/metrics/latency/timeseries?days=14"]);
  });

  it("a hostile --days value is percent-encoded into the query (no param injection)", async () => {
    const { paths } = await run(["summary", "--days", "7&admin=1"]);
    expect(paths).toEqual(["/api/admin/metrics/latency/summary?days=7%26admin%3D1"]);
    expect(paths[0]).not.toContain("admin=1");
  });

  it("hands the apiRequest result to writeOutput", async () => {
    expect((await run(["summary"])).written).toEqual([{ _path: "/api/admin/metrics/latency/summary" }]);
  });

  it("an unknown subcommand is a parse error", async () => {
    expect((await run(["bogus"])).exitCode).toBeDefined();
  });
});

describe("muse analytics — command parser + path wiring", () => {
  const run = (args: string[]) => runGroup(registerAnalyticsCommands as never, "analytics", args);

  it("failures / latency-distribution route to the fixed conversation-analytics paths", async () => {
    expect((await run(["failures"])).paths).toEqual(["/api/admin/conversation-analytics/failure-patterns"]);
    expect((await run(["latency-distribution"])).paths).toEqual(["/api/admin/conversation-analytics/latency-distribution"]);
  });

  it("hands the apiRequest result to writeOutput", async () => {
    expect((await run(["failures"])).written).toEqual([{ _path: "/api/admin/conversation-analytics/failure-patterns" }]);
  });

  it("an unknown subcommand is a parse error", async () => {
    expect((await run(["bogus"])).exitCode).toBeDefined();
  });
});
