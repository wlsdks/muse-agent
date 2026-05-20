import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerObjectivesCommands } from "./commands-objectives.js";

async function run(file: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prev = process.env.MUSE_OBJECTIVES_FILE;
  process.env.MUSE_OBJECTIVES_FILE = file;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerObjectivesCommands(program, io);
    await program.parseAsync(["node", "muse", "objectives", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    if (prev === undefined) delete process.env.MUSE_OBJECTIVES_FILE;
    else process.env.MUSE_OBJECTIVES_FILE = prev;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function objFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cli-obj-")), "objectives.json");
}

describe("muse objectives — CLI entry point to the delegated-autonomy chain", () => {
  it("add → list → cancel → list reflects through the real ~/.muse/objectives.json store", async () => {
    const file = objFile();
    const added = await run(file, ["add", "watch", "the", "deploy", "until", "green", "--kind", "until"]);
    expect(added.stdout).toMatch(/^Registered objective obj_[\w-]+: watch the deploy until green\n$/u);
    expect(added.exitCode).toBeUndefined();

    const listed = await run(file, ["list"]);
    expect(listed.stdout).toContain("[active/until]  watch the deploy until green");

    const id = added.stdout.replace(/^Registered objective (obj_[\w-]+):.*$/su, "$1").trim();
    const cancelled = await run(file, ["cancel", id]);
    expect(cancelled.stdout).toBe(`Cancelled ${id}\n`);

    // default --status active hides the cancelled one; --status all shows it
    expect((await run(file, ["list"])).stdout).toBe("No objectives.\n");
    expect((await run(file, ["list", "--status", "all"])).stdout).toContain("[cancelled/until]");
  });

  it("rejects an unknown --kind with a closest-match hint", async () => {
    const r = await run(objFile(), ["add", "do a thing", "--kind", "untl"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--kind must be one of: watch, until, notify");
    expect(r.stderr).toContain("did you mean 'until'");
  });

  it("cancel of a missing id errors cleanly (no crash, exit 1)", async () => {
    const r = await run(objFile(), ["cancel", "obj_nope"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no objective with id 'obj_nope'");
  });

  it("is user-scoped: a different --user does not see another bucket's objectives", async () => {
    const file = objFile();
    await run(file, ["add", "stark only", "--user", "stark"]);
    expect((await run(file, ["list", "--user", "stark"])).stdout).toContain("stark only");
    expect((await run(file, ["list", "--user", "other"])).stdout).toBe("No objectives.\n");
  });

  it("add and list resolve `--user '   '` to the same fallback bucket (no asymmetry that hides the just-added objective)", async () => {
    const file = objFile();
    await run(file, ["add", "trim test", "--user", "   "]);
    const listed = await run(file, ["list", "--user", "   "]);
    expect(listed.stdout, "list with the same whitespace --user must show the just-added objective; pre-fix it filtered by literal '' and returned 'No objectives.'").toContain("trim test");
    expect((await run(file, ["list", "--user", "local"])).stdout).toContain("trim test");
  });
});
