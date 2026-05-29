import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { registerPersonaCommand } from "./commands-persona.js";
import type { ProgramIO } from "./program.js";

// CLI command-parser + persistence round-trip (backlog P5) for `muse persona` —
// the one CLI group that reads stdin and writes a real store file (not the
// fake-apiRequest harness). MUSE_PERSONA_FILE points the store at a tmp file and
// io.readPipedStdin is injected, so add/use/remove/show round-trip on disk with
// no real home-dir writes. Asserts both the persisted state and the guards.

const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "muse-persona-")), "persona.json");
const prevEnv = process.env.MUSE_PERSONA_FILE;
afterEach(() => {
  if (prevEnv === undefined) delete process.env.MUSE_PERSONA_FILE;
  else process.env.MUSE_PERSONA_FILE = prevEnv;
});

const run = async (file: string, args: string[], opts: { stdin?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> => {
  process.env.MUSE_PERSONA_FILE = file;
  const savedExit = process.exitCode;
  process.exitCode = undefined;
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    stderr: (m: string) => err.push(m),
    stdout: (m: string) => out.push(m),
    ...(opts.stdin !== undefined ? { readPipedStdin: async () => opts.stdin! } : {}),
  } as ProgramIO;
  const program = new Command();
  program.exitOverride();
  registerPersonaCommand(program, io);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["node", "muse", "persona", ...args]);
    exitCode = process.exitCode; // the action sets process.exitCode=1 on a guard failure (no throw)
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  }
  process.exitCode = savedExit;
  return { exitCode, stderr: err.join(""), stdout: out.join("") };
};

describe("muse persona — add/use/remove/show round-trip + guards", () => {
  it("add (inline preamble) → list --json shows the custom persona → show --id returns its preamble", async () => {
    const file = tmpFile();
    expect((await run(file, ["add", "tony", "You", "are", "Tony"])).exitCode).toBeFalsy();
    const list = JSON.parse((await run(file, ["list", "--json"])).stdout) as { activeId: string; personas: { id: string; source: string }[] };
    expect(list.personas.find((p) => p.id === "tony")).toMatchObject({ source: "custom" });
    const show = JSON.parse((await run(file, ["show", "--id", "tony", "--json"])).stdout) as { preamble: string };
    expect(show.preamble).toBe("You are Tony");
  });

  it("add with no inline preamble reads it from piped stdin", async () => {
    const file = tmpFile();
    await run(file, ["add", "piped"], { stdin: "  preamble from stdin  " });
    const show = JSON.parse((await run(file, ["show", "--id", "piped", "--json"])).stdout) as { preamble: string };
    expect(show.preamble).toBe("preamble from stdin");
  });

  it("rejects adding a built-in id and an empty preamble (no custom persona written)", async () => {
    const file = tmpFile();
    expect((await run(file, ["add", "jarvis", "x"])).exitCode).toBe(1); // built-in collision
    const empty = await run(file, ["add", "ghost"], { stdin: "   " });
    expect(empty.exitCode).toBe(1); // empty preamble (inline + stdin both blank)
    const list = JSON.parse((await run(file, ["list", "--json"])).stdout) as { personas: { id: string }[] };
    expect(list.personas.map((p) => p.id)).not.toContain("ghost");
  });

  it("use flips the active id; an unknown id is rejected with a suggestion", async () => {
    const file = tmpFile();
    await run(file, ["add", "tony", "You are Tony"]);
    await run(file, ["use", "tony"]);
    expect((JSON.parse((await run(file, ["list", "--json"])).stdout) as { activeId: string }).activeId).toBe("tony");
    const bad = await run(file, ["use", "tonny"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("did you mean 'tony'");
  });

  it("remove deletes a custom persona and resets the active id to default when it was active", async () => {
    const file = tmpFile();
    await run(file, ["add", "tony", "You are Tony"]);
    await run(file, ["use", "tony"]);
    const removed = JSON.parse((await run(file, ["remove", "tony", "--json"])).stdout) as { resetActive: boolean; activeId: string };
    expect(removed).toMatchObject({ activeId: "default", resetActive: true });
    expect((JSON.parse((await run(file, ["list", "--json"])).stdout) as { activeId: string; personas: { id: string }[] }).personas.map((p) => p.id)).not.toContain("tony");
  });

  it("refuses to remove a built-in persona", async () => {
    expect((await run(tmpFile(), ["remove", "jarvis"])).exitCode).toBe(1);
  });

  it("show (active) prints the active persona's preamble", async () => {
    const file = tmpFile();
    await run(file, ["add", "tony", "You are Tony"]);
    await run(file, ["use", "tony"]);
    expect((JSON.parse((await run(file, ["show", "--json"])).stdout) as { activeId: string; preamble: string }))
      .toMatchObject({ activeId: "tony", preamble: "You are Tony" });
  });
});
