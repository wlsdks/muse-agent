import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { COMMAND_LOADERS, LOADER_BY_NAME } from "./command-loaders.js";
import { COMMAND_STUBS } from "./command-manifest.js";
import { tryVersionFastPath } from "./muse-version.js";
import { createProgram, type ProgramIO } from "./program.js";

/**
 * Behavioural coverage for the lazy command-dispatch wrapper: every command
 * must still resolve, render its own `--help`, complete, and surface a
 * "did you mean" — and a lazy-import failure must surface loudly, never as a
 * silent no-op. The eager/inline commands (not in the stub manifest) are
 * exercised by the wider program.test.ts suite.
 */

const captureIo = (): { io: ProgramIO; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    stdout: (s: string) => { out.push(s); },
    stderr: (s: string) => { err.push(s); }
  } as unknown as ProgramIO;
  return { io, out, err };
};

const stubDeps = new Proxy({}, { get: () => () => undefined });

describe("lazy dispatch — resolvability + per-command help", () => {
  it("every stub command name resolves to a lazy loader", () => {
    for (const stub of COMMAND_STUBS) {
      expect(LOADER_BY_NAME.get(stub.name), `unresolved: ${stub.name}`).toBeDefined();
    }
  });

  it("every lazy command, once loaded, renders its own --help", async () => {
    const real = new Command();
    for (const loader of COMMAND_LOADERS) {
      await loader.load(real, captureIo().io, stubDeps as never);
    }
    for (const stub of COMMAND_STUBS) {
      const command = real.commands.find((c) => c.name() === stub.name);
      expect(command, `missing real command: ${stub.name}`).toBeDefined();
      const help = command!.helpInformation();
      expect(help).toContain(stub.name);
      expect(help).toContain("Usage:");
    }
  });
});

describe("lazy dispatch — real invocation through the parseAsync wrapper", () => {
  it("`muse <lazy-cmd> --help` loads the real command and prints its help", async () => {
    // A representative spread: a leaf command with options and several groups.
    for (const name of ["status", "memory", "calendar", "today", "setup", "tasks"]) {
      const { io, out } = captureIo();
      const program = createProgram(io);
      program.exitOverride();
      try {
        await program.parseAsync(["node", "muse", name, "--help"], { from: "node" });
      } catch (error) {
        // commander throws (helpDisplayed) after writing the help via exitOverride.
        expect((error as { code?: string }).code).toBe("commander.helpDisplayed");
      }
      const text = out.join("");
      expect(text, `no help rendered for ${name}`).toContain("Usage:");
      expect(text).toContain(name);
    }
  });

  it("a group's typo'd subcommand still gets grounded guidance after lazy load", async () => {
    const prevExit = process.exitCode;
    process.exitCode = 0;
    try {
      const { io, err } = captureIo();
      const program = createProgram(io);
      await program.parseAsync(["node", "muse", "memory", "bogus-sub"], { from: "node" });
      const text = err.join("");
      expect(text).toContain("unknown command 'muse memory bogus-sub'");
      expect(text).toContain("Available memory commands:");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExit;
    }
  });
});

describe("lazy dispatch — discovery surfaces stay off the stubs (fast path)", () => {
  it("did-you-mean fires for a near-miss typo without loading handlers", async () => {
    const prevExit = process.exitCode;
    process.exitCode = 0;
    try {
      const { io, err } = captureIo();
      const program = createProgram(io);
      await program.parseAsync(["node", "muse", "statu"], { from: "node" });
      expect(err.join("")).toContain("Did you mean 'muse status'?");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExit;
    }
  });

  it("completion enumerates lazy commands AND a lazy group's subcommands from the stubs", async () => {
    const { io, out } = captureIo();
    const program = createProgram(io);
    await program.parseAsync(["node", "muse", "completion", "bash"], { from: "node" });
    const script = out.join("");
    expect(script).toContain("status");
    expect(script).toContain("calendar");
    // calendar is a lazy GROUP — its subcommands must still appear via the stub subtree.
    expect(script).toMatch(/calendar\)\s+COMPREPLY/);
  });
});

describe("lazy dispatch — failure is loud (fail-closed), never a silent no-op", () => {
  it("a failing lazy import rejects parseAsync so index.ts can surface it", async () => {
    const { io } = captureIo();
    const program = createProgram(io);
    const boom = {
      id: "__boom__",
      names: ["__boom__"],
      load: async () => { throw new Error("simulated import failure"); }
    };
    // LOADER_BY_NAME is a live Map; inject a throwing loader for one invocation.
    (LOADER_BY_NAME as unknown as Map<string, typeof boom>).set("__boom__", boom);
    try {
      await expect(
        program.parseAsync(["node", "muse", "__boom__"], { from: "node" })
      ).rejects.toThrow("simulated import failure");
    } finally {
      (LOADER_BY_NAME as unknown as Map<string, typeof boom>).delete("__boom__");
    }
  });
});

describe("--version fast path is unchanged", () => {
  it("prints the version for the exact `--version` / `-V` line only", () => {
    const seen: string[] = [];
    expect(tryVersionFastPath(["node", "muse", "--version"], (t) => seen.push(t))).toBe(true);
    expect(tryVersionFastPath(["node", "muse", "-V"], (t) => seen.push(t))).toBe(true);
    expect(tryVersionFastPath(["node", "muse", "status"], (t) => seen.push(t))).toBe(false);
    expect(seen.join("")).toMatch(/^\d+\.\d+\.\d+/);
  });
});
