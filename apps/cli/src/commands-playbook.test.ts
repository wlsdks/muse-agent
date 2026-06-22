import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerPlaybookCommands } from "./commands-playbook.js";

type IO = Parameters<typeof registerPlaybookCommands>[1];
const noopIo = { stderr: () => undefined, stdout: () => undefined } as unknown as IO;

function findSub(program: Command, names: readonly string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const name of names) {
    current = current?.commands.find((command) => command.name() === name);
  }
  return current;
}

describe("muse playbook command registration", () => {
  it("registers the distill subcommand (ReasoningBank slice 2)", () => {
    const program = new Command();
    registerPlaybookCommands(program, noopIo);
    const distill = findSub(program, ["playbook", "distill"]);
    expect(distill).toBeDefined();
    expect(distill?.description()).toContain("last chat session");
  });

  it("keeps add/list/remove/reward/undo/pause/resume alongside distill", () => {
    const program = new Command();
    registerPlaybookCommands(program, noopIo);
    for (const name of ["add", "list", "remove", "reward", "undo", "pause", "resume", "distill"]) {
      expect(findSub(program, ["playbook", name])).toBeDefined();
    }
  });
});

describe("muse playbook pause / resume — the learning kill switch (B1 §5)", () => {
  it("pause persists paused:true (with since); resume clears it", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { isLearningPaused } = await import("@muse/stores");
    const dir = await mkdtemp(join(tmpdir(), "muse-pause-"));
    const pauseFile = join(dir, "learning-paused.json");
    const prev = process.env.MUSE_LEARNING_PAUSE_FILE;
    process.env.MUSE_LEARNING_PAUSE_FILE = pauseFile;
    try {
      const run = async (args: string[]): Promise<string> => {
        const out: string[] = [];
        const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
        const program = new Command();
        registerPlaybookCommands(program, io);
        await program.parseAsync(["node", "x", "playbook", ...args], { from: "node" });
        return out.join("");
      };
      expect(await run(["pause"])).toContain("paused");
      expect(await isLearningPaused(pauseFile)).toBe(true);
      expect(await run(["resume"])).toContain("resumed");
      expect(await isLearningPaused(pauseFile)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MUSE_LEARNING_PAUSE_FILE; else process.env.MUSE_LEARNING_PAUSE_FILE = prev;
    }
  });
});

describe("muse playbook undo — remove AND teach not to re-learn (B1 §5)", () => {
  it("removes the strategy and records a suppressed lesson with its text", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { recordPlaybookStrategy, queryPlaybook, querySuppressedLessons } = await import("@muse/stores");
    const dir = await mkdtemp(join(tmpdir(), "muse-pbundo-"));
    const file = join(dir, "playbook.json");
    const suppressed = join(dir, "suppressed.json");
    const prevPb = process.env.MUSE_PLAYBOOK_FILE;
    const prevSup = process.env.MUSE_SUPPRESSED_LESSONS_FILE;
    process.env.MUSE_PLAYBOOK_FILE = file;
    process.env.MUSE_SUPPRESSED_LESSONS_FILE = suppressed;
    try {
      await recordPlaybookStrategy(file, { createdAt: "2026-01-01T00:00:00Z", id: "pb_undo1", text: "always answer in bullet points", origin: "grounded", source: "no, give me bullets not prose", userId: "u" });
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
      const program = new Command();
      registerPlaybookCommands(program, io);
      await program.parseAsync(["node", "x", "playbook", "undo", "pb_undo"], { from: "node" }); // prefix id
      expect(out.join("")).toContain("won't re-learn");
      expect(await queryPlaybook(file)).toEqual([]); // removed
      const vetoes = await querySuppressedLessons(suppressed, "u");
      expect(vetoes.map((v) => v.text)).toEqual(["always answer in bullet points"]); // taught
      expect(vetoes[0]?.source).toBe("no, give me bullets not prose"); // the signal carried from provenance
    } finally {
      if (prevPb === undefined) delete process.env.MUSE_PLAYBOOK_FILE; else process.env.MUSE_PLAYBOOK_FILE = prevPb;
      if (prevSup === undefined) delete process.env.MUSE_SUPPRESSED_LESSONS_FILE; else process.env.MUSE_SUPPRESSED_LESSONS_FILE = prevSup;
    }
  });
});

describe("muse playbook reward — manual reinforce/penalise", () => {
  it("reinforces by the amount, and `--down` penalises (clamped, prefix-matched id)", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { recordPlaybookStrategy, queryPlaybook } = await import("@muse/stores");
    const dir = await mkdtemp(join(tmpdir(), "muse-pbreward-"));
    const file = join(dir, "playbook.json");
    const prev = process.env.MUSE_PLAYBOOK_FILE;
    process.env.MUSE_PLAYBOOK_FILE = file;
    try {
      await recordPlaybookStrategy(file, { createdAt: "2026-01-01T00:00:00Z", id: "pb_xyz123", text: "t", userId: "u" });
      const run = async (args: string[]): Promise<string> => {
        const out: string[] = [];
        const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as IO;
        const program = new Command();
        registerPlaybookCommands(program, io);
        await program.parseAsync(["node", "x", "playbook", ...args], { from: "node" });
        return out.join("");
      };
      expect(await run(["reward", "pb_xyz", "2"])).toContain("reward → +2"); // prefix id, +2
      expect((await queryPlaybook(file))[0]!.reward).toBe(2);
      await run(["reward", "pb_xyz", "5", "--down"]); // -5 → clamps at floor -5 (2-5=-3)
      expect((await queryPlaybook(file))[0]!.reward).toBe(-3);
      expect(await run(["reward", "nope", "1"])).toContain("no strategy matches");
    } finally {
      if (prev === undefined) delete process.env.MUSE_PLAYBOOK_FILE;
      else process.env.MUSE_PLAYBOOK_FILE = prev;
    }
  });
});
