import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { normalizeBeforeTimestamp, registerRunsCommands, type RunsCommandHelpers } from "./commands-runs.js";

function harness(): {
  run: (args: string[]) => Promise<unknown>;
  requests: { path: string; method?: string }[];
  stderr: () => string;
  exitCode: () => number | string | null | undefined;
} {
  const stderr: string[] = [];
  const requests: { path: string; method?: string }[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: () => { /* no-op */ } };
  const helpers: RunsCommandHelpers = {
    apiRequest: async (_io, _command, path, _body, method) => {
      requests.push({ method, path });
      return { ok: true };
    },
    writeOutput: () => { /* no-op */ }
  };
  const program = new Command();
  program.exitOverride();
  registerRunsCommands(program, io as never, helpers);
  return {
    exitCode: () => process.exitCode,
    requests,
    run: (args) => program.parseAsync(["node", "muse", "runs", ...args]),
    stderr: () => stderr.join("")
  };
}

describe("normalizeBeforeTimestamp", () => {
  it("canonicalises a valid date / datetime to a full ISO timestamp", () => {
    expect(normalizeBeforeTimestamp("2026-05-20T14:00:00Z")).toBe("2026-05-20T14:00:00.000Z");
    expect(normalizeBeforeTimestamp("2026-05-20")).toBe("2026-05-20T00:00:00.000Z");
    expect(normalizeBeforeTimestamp("  2026-05-20  ")).toBe("2026-05-20T00:00:00.000Z");
  });

  it("returns undefined for an unparseable / empty value", () => {
    expect(normalizeBeforeTimestamp("yesterday")).toBeUndefined();
    expect(normalizeBeforeTimestamp("not-a-date")).toBeUndefined();
    expect(normalizeBeforeTimestamp("")).toBeUndefined();
    expect(normalizeBeforeTimestamp("   ")).toBeUndefined();
  });
});

describe("muse runs delete — guards the bulk --before against a malformed timestamp", () => {
  it("rejects a malformed --before WITHOUT issuing the DELETE", async () => {
    const h = harness();
    process.exitCode = 0;
    await h.run(["delete", "--before", "yesterday"]);
    expect(h.requests, "no DELETE must reach the API for a bad timestamp").toHaveLength(0);
    expect(h.stderr()).toContain("--before must be a valid timestamp");
    expect(h.exitCode()).toBe(1);
    process.exitCode = 0;
  });

  it("canonicalises a valid --before to ISO in the DELETE query", async () => {
    const h = harness();
    await h.run(["delete", "--before", "2026-05-20"]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.method).toBe("DELETE");
    expect(h.requests[0]!.path).toBe(`/api/admin/runs?before=${encodeURIComponent("2026-05-20T00:00:00.000Z")}`);
  });

  it("still deletes a single run by id (unchanged path)", async () => {
    const h = harness();
    await h.run(["delete", "run_abc"]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.path).toBe("/api/admin/runs/run_abc");
  });
});
