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
    expect((await run(file, ["list"])).stdout).toBe("No objectives yet. Register one with `muse objectives add \"watch the deploy until it is green\"`.\n");
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

  it("cancel accepts an unambiguous id prefix (no need to paste the whole obj_<uuid>)", async () => {
    const file = objFile();
    const added = await run(file, ["add", "watch the build until green"]);
    const fullId = added.stdout.match(/(obj_[a-z0-9-]+)/u)?.[1];
    expect(fullId).toMatch(/^obj_[a-z0-9-]+$/u);
    const prefix = fullId!.slice(0, 12); // "obj_" + first 8 of the uuid — unique with one objective
    const cancelled = await run(file, ["cancel", prefix]);
    expect(cancelled.exitCode).toBeUndefined();
    // Reports the FULL resolved id, and the store reflects the cancel.
    expect(cancelled.stdout).toBe(`Cancelled ${fullId!}\n`);
    expect((await run(file, ["list", "--status", "all"])).stdout).toContain("[cancelled/until]");
  });

  it("cancel refuses an ambiguous prefix — matches >1, cancels nothing", async () => {
    const file = objFile();
    await run(file, ["add", "first objective"]);
    await run(file, ["add", "second objective"]);
    // "obj_" is a prefix of every generated id.
    const r = await run(file, ["cancel", "obj_"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ambiguous objective id 'obj_' — matches 2");
    // Neither was cancelled — both still active.
    const active = await run(file, ["list", "--json"]);
    expect(JSON.parse(active.stdout).total).toBe(2);
  });

  it("cancel suggests the closest existing id on a near-miss typo", async () => {
    const file = objFile();
    const adds = await run(file, ["add", "ship the thing"]);
    expect(adds.exitCode).toBeUndefined();
    const realId = adds.stdout.match(/(obj_[a-z0-9-]+)/u)?.[1];
    expect(realId).toMatch(/^obj_[a-z0-9-]+$/u);
    const typo = `${realId!.slice(0, -1)}x`;
    const r = await run(file, ["cancel", typo]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`no objective with id '${typo}'`);
    expect(r.stderr).toContain(`did you mean '${realId!}'`);
  });

  it("done marks an objective accomplished — distinct from cancel (status 'done', not 'cancelled')", async () => {
    const file = objFile();
    const added = await run(file, ["add", "ship the Q3 memo", "--kind", "until"]);
    const id = added.stdout.match(/(obj_[a-z0-9-]+)/u)?.[1];
    expect(id).toMatch(/^obj_[a-z0-9-]+$/u);
    const done = await run(file, ["done", id!]);
    expect(done.exitCode).toBeUndefined();
    expect(done.stdout).toBe(`Marked done ${id!}\n`);
    // It records as done, NOT cancelled (the accountability distinction).
    const all = await run(file, ["list", "--status", "all", "--json"]);
    const parsed = JSON.parse(all.stdout) as { objectives: Array<{ status: string }> };
    expect(parsed.objectives[0]?.status).toBe("done");
    expect((await run(file, ["list", "--status", "done"])).stdout).toContain("[done/until]");
  });

  it("done accepts an unambiguous prefix and reports a missing id cleanly", async () => {
    const file = objFile();
    const added = await run(file, ["add", "review the deploy"]);
    const id = added.stdout.match(/(obj_[a-z0-9-]+)/u)?.[1];
    const byPrefix = await run(file, ["done", id!.slice(0, 12)]);
    expect(byPrefix.exitCode).toBeUndefined();
    expect(byPrefix.stdout).toBe(`Marked done ${id!}\n`);
    const missing = await run(objFile(), ["done", "obj_nope"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("no objective with id 'obj_nope'");
  });

  it("is user-scoped: a different --user does not see another bucket's objectives", async () => {
    const file = objFile();
    await run(file, ["add", "stark only", "--user", "stark"]);
    expect((await run(file, ["list", "--user", "stark"])).stdout).toContain("stark only");
    expect((await run(file, ["list", "--user", "other"])).stdout).toBe("No objectives yet. Register one with `muse objectives add \"watch the deploy until it is green\"`.\n");
  });

  it("list --json emits a machine-readable envelope { objectives, status, total, user } — empty store returns total=0 + empty objectives (not the friendly stdout message)", async () => {
    const empty = objFile();
    const r1 = await run(empty, ["list", "--json"]);
    expect(r1.exitCode).toBeUndefined();
    expect(r1.stdout, "json mode must NOT emit the human-readable empty-state line").not.toContain("No objectives yet");
    const parsedEmpty = JSON.parse(r1.stdout) as { objectives: unknown[]; status: string; total: number; user: string };
    expect(parsedEmpty.objectives).toEqual([]);
    expect(parsedEmpty.total).toBe(0);
    expect(parsedEmpty.status).toBe("active");
    expect(parsedEmpty.user).toBe("local");

    const file = objFile();
    const added = await run(file, ["add", "watch the deploy", "--kind", "watch"]);
    expect(added.exitCode).toBeUndefined();
    const id = added.stdout.match(/(obj_[a-z0-9-]+)/u)?.[1];
    expect(id).toMatch(/^obj_[a-z0-9-]+$/u);
    const r2 = await run(file, ["list", "--json"]);
    expect(r2.exitCode).toBeUndefined();
    const parsed = JSON.parse(r2.stdout) as { objectives: Array<{ id: string; spec: string; kind: string; status: string }>; total: number; status: string; user: string };
    expect(parsed.total).toBe(1);
    expect(parsed.objectives[0]?.id).toBe(id);
    expect(parsed.objectives[0]?.kind).toBe("watch");
    expect(parsed.objectives[0]?.status).toBe("active");
    expect(parsed.objectives[0]?.spec).toBe("watch the deploy");
    expect(parsed.user).toBe("local");

    // --status all under --json composes correctly: after cancel, status=all returns 1 cancelled, default (active) returns 0.
    await run(file, ["cancel", id!]);
    const r3a = await run(file, ["list", "--json"]);
    const parsed3a = JSON.parse(r3a.stdout) as { total: number };
    expect(parsed3a.total).toBe(0);
    const r3b = await run(file, ["list", "--status", "all", "--json"]);
    const parsed3b = JSON.parse(r3b.stdout) as { objectives: Array<{ status: string }>; total: number; status: string };
    expect(parsed3b.total).toBe(1);
    expect(parsed3b.status).toBe("all");
    expect(parsed3b.objectives[0]?.status).toBe("cancelled");
  });

  it("add and list resolve `--user '   '` to the same fallback bucket (no asymmetry that hides the just-added objective)", async () => {
    const file = objFile();
    await run(file, ["add", "trim test", "--user", "   "]);
    const listed = await run(file, ["list", "--user", "   "]);
    expect(listed.stdout, "list with the same whitespace --user must show the just-added objective; pre-fix it filtered by literal '' and returned 'No objectives.'").toContain("trim test");
    expect((await run(file, ["list", "--user", "local"])).stdout).toContain("trim test");
  });
});
