import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerOrchestrateCommands, type OrchestrateHelpers } from "./commands-orchestrate.js";

interface Captured {
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: { path: string; body?: Record<string, unknown>; method?: string }[];
}

function harness(): { run: (args: string[]) => Promise<unknown>; captured: Captured } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: { path: string; body?: Record<string, unknown>; method?: string }[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const helpers: OrchestrateHelpers = {
    apiRequest: async (_io, _command, path, body, method) => {
      requests.push({ body, method, path });
      return { ok: true };
    },
    writeOutput: () => { /* no-op */ }
  };
  const program = new Command();
  program.exitOverride();
  registerOrchestrateCommands(program, io, helpers);
  return {
    captured: { requests, stderr: stderr.join(""), stdout: stdout.join("") } as never as Captured,
    run: (args) => program.parseAsync(["node", "muse", "orchestrate", ...args])
  };
}

describe("muse orchestrate run — mode validation", () => {
  it("accepts the three documented modes", async () => {
    for (const mode of ["sequential", "parallel", "race"]) {
      const h = harness();
      await expect(h.run(["run", "hello", "--mode", mode])).resolves.toBeDefined();
    }
  });

  it("rejects an unknown mode with a `did you mean` hint for a near-miss typo", async () => {
    const h = harness();
    await expect(h.run(["run", "hello", "--mode", "parralel"]))
      .rejects.toThrow(/--mode must be 'sequential', 'parallel', or 'race'.*did you mean 'parallel'/u);
  });

  it("rejects an unknown mode WITHOUT a guess when nothing is close (no random suggestion)", async () => {
    const h = harness();
    await expect(h.run(["run", "hello", "--mode", "totallydifferent"]))
      .rejects.toThrow(/--mode must be 'sequential', 'parallel', or 'race' \(got 'totallydifferent'\)$/u);
  });
});
