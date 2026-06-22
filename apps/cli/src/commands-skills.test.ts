import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { readSkillRewards } from "@muse/stores";
import { AuthoredSkillStore } from "@muse/skills";

import {
  buildSkillScaffold,
  isSafeSkillName,
  registerSkillsCommands,
  resolveAuthoredSkillsDir,
  resolveSkillRewardsFile,
  resolveSkillsDir
} from "./commands-skills.js";
import type { ProgramIO } from "./program.js";

describe("resolveSkillsDir", () => {
  it("honours MUSE_SKILLS_DIR, else defaults under ~/.muse/skills", () => {
    expect(resolveSkillsDir({ MUSE_SKILLS_DIR: "/tmp/s" } as NodeJS.ProcessEnv)).toBe("/tmp/s");
    expect(resolveSkillsDir({} as NodeJS.ProcessEnv).endsWith("/.muse/skills")).toBe(true);
  });
});

describe("resolveAuthoredSkillsDir", () => {
  it("honours MUSE_AUTHORED_SKILLS_DIR, else defaults under ~/.muse/skills/authored", () => {
    expect(resolveAuthoredSkillsDir({ MUSE_AUTHORED_SKILLS_DIR: "/tmp/a" } as NodeJS.ProcessEnv)).toBe("/tmp/a");
    expect(resolveAuthoredSkillsDir({} as NodeJS.ProcessEnv).endsWith("/.muse/skills/authored")).toBe(true);
  });
});

describe("resolveSkillRewardsFile", () => {
  it("honours MUSE_SKILL_REWARDS_FILE, else defaults under ~/.muse/skill-rewards.json", () => {
    expect(resolveSkillRewardsFile({ MUSE_SKILL_REWARDS_FILE: "/tmp/r.json" } as NodeJS.ProcessEnv)).toBe("/tmp/r.json");
    expect(resolveSkillRewardsFile({} as NodeJS.ProcessEnv).endsWith("/.muse/skill-rewards.json")).toBe(true);
  });
});

describe("muse skills reward — manual reinforce/penalise", () => {
  it("adjusts an authored skill's reward (--down penalises), and refuses an unknown skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-skreward-"));
    const authoredDir = join(dir, "authored");
    const rewardsFile = join(dir, "skill-rewards.json");
    const prevA = process.env.MUSE_AUTHORED_SKILLS_DIR;
    const prevR = process.env.MUSE_SKILL_REWARDS_FILE;
    process.env.MUSE_AUTHORED_SKILLS_DIR = authoredDir;
    process.env.MUSE_SKILL_REWARDS_FILE = rewardsFile;
    try {
      await new AuthoredSkillStore({ dir: authoredDir }).writeOrPatch({ body: "do the thing", description: "fix a vpn", name: "vpn-fix" });
      const run = async (args: string[]): Promise<string> => {
        const out: string[] = [];
        const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as ProgramIO;
        const program = new Command();
        registerSkillsCommands(program, io);
        await program.parseAsync(["node", "x", "skills", ...args], { from: "node" });
        return out.join("");
      };
      expect(await run(["reward", "vpn-fix", "3"])).toContain("reward → +3");
      expect((await readSkillRewards(rewardsFile))["vpn-fix"]).toBe(3);
      await run(["reward", "vpn-fix", "2", "--down"]); // 3 - 2 = 1
      expect((await readSkillRewards(rewardsFile))["vpn-fix"]).toBe(1);
      expect(await run(["reward", "ghost", "1"])).toContain("no authored skill named");
      expect(await readSkillRewards(rewardsFile)).not.toHaveProperty("ghost"); // unknown skill never written
    } finally {
      if (prevA === undefined) delete process.env.MUSE_AUTHORED_SKILLS_DIR; else process.env.MUSE_AUTHORED_SKILLS_DIR = prevA;
      if (prevR === undefined) delete process.env.MUSE_SKILL_REWARDS_FILE; else process.env.MUSE_SKILL_REWARDS_FILE = prevR;
    }
  });
});

describe("isSafeSkillName", () => {
  it("accepts plain names, rejects traversal / odd chars", () => {
    expect(isSafeSkillName("weather")).toBe(true);
    expect(isSafeSkillName("my skill_1")).toBe(true);
    expect(isSafeSkillName("../etc")).toBe(false);
    expect(isSafeSkillName("/abs")).toBe(false);
    expect(isSafeSkillName("")).toBe(false);
  });
});

describe("buildSkillScaffold", () => {
  it("produces valid SKILL.md frontmatter with the given name + description", () => {
    const md = buildSkillScaffold("planner", "plans my day");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: planner");
    expect(md).toContain("description: plans my day");
    expect(md).toContain("# planner");
  });
});
