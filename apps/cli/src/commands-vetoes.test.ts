import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { formatVetoList, registerVetoesCommands } from "./commands-vetoes.js";

type IO = Parameters<typeof registerVetoesCommands>[1];
const noopIo = { stderr: () => undefined, stdout: () => undefined } as unknown as IO;

function findSub(program: Command, names: readonly string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const name of names) {
    current = current?.commands.find((command) => command.name() === name);
  }
  return current;
}

async function withTempVetoesFile<T>(run: (file: string) => Promise<T>): Promise<T> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "muse-vetoes-"));
  const file = join(dir, "vetoes.json");
  const prev = process.env.MUSE_VETOES_FILE;
  process.env.MUSE_VETOES_FILE = file;
  try {
    return await run(file);
  } finally {
    if (prev === undefined) delete process.env.MUSE_VETOES_FILE; else process.env.MUSE_VETOES_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCli(io: IO, args: string[]): Promise<void> {
  const program = new Command();
  registerVetoesCommands(program, io);
  await program.parseAsync(["node", "x", "vetoes", ...args], { from: "node" });
}

describe("muse vetoes command registration", () => {
  it("registers list and remove under the vetoes group", () => {
    const program = new Command();
    registerVetoesCommands(program, noopIo);
    expect(findSub(program, ["vetoes", "list"])).toBeDefined();
    expect(findSub(program, ["vetoes", "remove"])).toBeDefined();
  });

  it("remove requires an id argument", () => {
    const program = new Command();
    registerVetoesCommands(program, noopIo);
    const remove = findSub(program, ["vetoes", "remove"]) as unknown as { registeredArguments: ReadonlyArray<{ required: boolean }> };
    expect(remove.registeredArguments).toHaveLength(1);
    expect(remove.registeredArguments[0]?.required).toBe(true);
  });
});

describe("formatVetoList — pure render", () => {
  it("says nothing is vetoed when the list is empty", () => {
    expect(formatVetoList([])).toContain("No vetoed actions");
  });

  it("lists each veto with its escape hatch", () => {
    const out = formatVetoList([
      { id: "veto_email-followups_send", objectiveId: "email-followups", reason: "too pushy", scope: "send", userId: "u1", vetoedAt: "2026-07-01T00:00:00Z" }
    ]);
    expect(out).toContain("[veto_email-followups_send] email-followups · send — too pushy  (vetoed 2026-07-01)");
    expect(out).toContain("muse vetoes remove <id>");
  });

  it("strips terminal escape/control bytes and collapses an embedded newline from objectiveId/scope/reason (untrusted model-derived text)", () => {
    const hostile = "evil\x1b[2J\x1b[31mPWNED\x1b[0m\nFAKE SECTION:\n  • injected";
    const out = formatVetoList([
      { id: "veto_x", objectiveId: hostile, reason: hostile, scope: hostile, userId: "u1", vetoedAt: "2026-07-01T00:00:00Z" }
    ]);
    expect(out.includes("\x1b")).toBe(false);
    expect(out).not.toContain("FAKE SECTION:\n"); // the newline that would forge a new line is collapsed to a space
    expect(out.split("\n").filter((line) => line.length > 0)).toHaveLength(3); // header + one veto line + trailer — no forged extra line
  });
});

describe("muse vetoes list — reads the real store", () => {
  it("shows a recorded veto and scopes to the given user by default", async () => {
    await withTempVetoesFile(async (file) => {
      const { recordVeto } = await import("@muse/stores");
      await recordVeto(file, { id: "veto_a_scope", objectiveId: "a", scope: "scope", userId: "u1", vetoedAt: "2026-07-01T00:00:00Z" });
      await recordVeto(file, { id: "veto_b_scope", objectiveId: "b", scope: "scope", userId: "u2", vetoedAt: "2026-07-02T00:00:00Z" });
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
      await runCli(io, ["list", "--user", "u1"]);
      const text = out.join("");
      expect(text).toContain("veto_a_scope");
      expect(text).not.toContain("veto_b_scope"); // scoped out
    });
  });

  it("--all shows every user's vetoes", async () => {
    await withTempVetoesFile(async (file) => {
      const { recordVeto } = await import("@muse/stores");
      await recordVeto(file, { id: "veto_a_scope", objectiveId: "a", scope: "scope", userId: "u1", vetoedAt: "2026-07-01T00:00:00Z" });
      await recordVeto(file, { id: "veto_b_scope", objectiveId: "b", scope: "scope", userId: "u2", vetoedAt: "2026-07-02T00:00:00Z" });
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
      await runCli(io, ["list", "--all"]);
      const text = out.join("");
      expect(text).toContain("veto_a_scope");
      expect(text).toContain("veto_b_scope");
    });
  });
});

describe("muse vetoes remove — the missing undo path", () => {
  it("removes a veto by exact id so Muse can act on that class again", async () => {
    await withTempVetoesFile(async (file) => {
      const { recordVeto, queryVetoes } = await import("@muse/stores");
      await recordVeto(file, { id: "veto_a_scope", objectiveId: "a", scope: "scope", userId: "u1", vetoedAt: "2026-07-01T00:00:00Z" });
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
      await runCli(io, ["remove", "veto_a_scope", "--user", "u1"]);
      expect(out.join("")).toContain("Removed veto");
      expect(await queryVetoes(file)).toEqual([]);
    });
  });

  it("matches an unambiguous id prefix", async () => {
    await withTempVetoesFile(async (file) => {
      const { recordVeto, queryVetoes } = await import("@muse/stores");
      await recordVeto(file, { id: "veto_a_scope", objectiveId: "a", scope: "scope", userId: "u1", vetoedAt: "2026-07-01T00:00:00Z" });
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
      await runCli(io, ["remove", "veto_a", "--user", "u1"]);
      expect(await queryVetoes(file)).toEqual([]);
      expect(out.join("")).toContain("Removed veto");
    });
  });

  it("a missing id is a clean no-op — no crash, no mutation", async () => {
    await withTempVetoesFile(async (file) => {
      const { recordVeto, queryVetoes } = await import("@muse/stores");
      await recordVeto(file, { id: "veto_a_scope", objectiveId: "a", scope: "scope", userId: "u1", vetoedAt: "2026-07-01T00:00:00Z" });
      const before = await queryVetoes(file);
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
      await expect(runCli(io, ["remove", "does-not-exist", "--user", "u1"])).resolves.not.toThrow();
      expect(out.join("")).toContain("no veto matches");
      expect(await queryVetoes(file)).toEqual(before); // unchanged
    });
  });

  it("--json reports removed:false for a missing id without throwing", async () => {
    await withTempVetoesFile(async (_file) => {
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
      await runCli(io, ["remove", "does-not-exist", "--json"]);
      expect(JSON.parse(out.join(""))).toEqual({ id: "does-not-exist", removed: false });
    });
  });

  it("Defect repro — an ambiguous prefix REFUSES instead of silently picking the newest match", async () => {
    await withTempVetoesFile(async (file) => {
      const { recordVeto, queryVetoes } = await import("@muse/stores");
      // Two vetoes sharing the "veto_email_" prefix, same user — the exact
      // ambiguity the review reproduced (`veto_email_send` / `veto_email_draft`).
      await recordVeto(file, { id: "veto_email_send", objectiveId: "email", reason: "send", scope: "send", userId: "u1", vetoedAt: "2026-07-01T00:00:00Z" });
      await recordVeto(file, { id: "veto_email_draft", objectiveId: "email", reason: "draft", scope: "draft", userId: "u1", vetoedAt: "2026-07-02T00:00:00Z" });
      const stderrLines: string[] = [];
      const out: string[] = [];
      const io = { stderr: (m: string) => stderrLines.push(m), stdout: (m: string) => out.push(m) } as unknown as IO;
      const prevExitCode = process.exitCode;
      try {
        await runCli(io, ["remove", "veto_email", "--user", "u1"]);
        expect(process.exitCode).toBe(1); // refused, not a silent success
      } finally {
        process.exitCode = prevExitCode;
      }
      expect(stderrLines.join("")).toContain("matches 2 vetoes");
      expect(out.join("")).not.toContain("Removed veto"); // no guess, nothing removed
      // BOTH vetoes still present — neither the newest nor any other was deleted
      const remaining = await queryVetoes(file, { userId: "u1" });
      expect(remaining.map((v) => v.id).sort()).toEqual(["veto_email_draft", "veto_email_send"]);
    });
  });

  it("Defect repro — a bare id/prefix never reaches another user's veto (cross-user deletion)", async () => {
    await withTempVetoesFile(async (file) => {
      const { recordVeto, queryVetoes } = await import("@muse/stores");
      await recordVeto(file, { id: "veto_other_user", objectiveId: "email", scope: "send", userId: "u2", vetoedAt: "2026-07-01T00:00:00Z" });
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
      // Acting as u1 (MUSE_USER_ID / --user), targeting u2's veto by its exact id.
      await runCli(io, ["remove", "veto_other_user", "--user", "u1"]);
      expect(out.join("")).toContain("no veto matches");
      // u2's veto is untouched — the safety record that re-enables an
      // autonomous action class was never at risk from a different user's command.
      expect(await queryVetoes(file, { userId: "u2" })).toHaveLength(1);
    });
  });

  it("--all is the explicit escape hatch for removing another user's veto", async () => {
    await withTempVetoesFile(async (file) => {
      const { recordVeto, queryVetoes } = await import("@muse/stores");
      await recordVeto(file, { id: "veto_other_user", objectiveId: "email", scope: "send", userId: "u2", vetoedAt: "2026-07-01T00:00:00Z" });
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
      await runCli(io, ["remove", "veto_other_user", "--user", "u1", "--all"]);
      expect(out.join("")).toContain("Removed veto");
      expect(await queryVetoes(file, { userId: "u2" })).toEqual([]);
    });
  });
});
