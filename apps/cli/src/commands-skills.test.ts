import { describe, expect, it } from "vitest";

import {
  buildSkillScaffold,
  isSafeSkillName,
  resolveAuthoredSkillsDir,
  resolveSkillsDir
} from "./commands-skills.js";

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
