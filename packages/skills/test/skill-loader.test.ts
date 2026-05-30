import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemSkillLoader, loadSkillsFromDirectory } from "../src/skill-loader.js";

// Direct coverage for the filesystem skill loader (untested module). The loader
// is the orchestration seam under skill discovery, and two of its properties are
// load-bearing:
//   - FAIL-OPEN: one malformed SKILL.md must NOT block every other skill (a
//     thrown error here would silently disable the whole skill set).
//   - PRECEDENCE: "later root wins" is what lets a workspace skill SHADOW a
//     user-global one of the same name — get the order wrong and the user's
//     override is ignored.

const roots: string[] = [];
afterEach(() => { roots.length = 0; });

const freshRoot = (): string => {
  const r = mkdtempSync(join(tmpdir(), "muse-skill-"));
  roots.push(r);
  return r;
};
const skillMd = (name: string, description: string, body = "Steps here."): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const writeSkill = (root: string, dir: string, contents: string | null): string => {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  if (contents !== null) writeFileSync(join(d, "SKILL.md"), contents);
  return d;
};

describe("loadSkillsFromDirectory", () => {
  it("loads every immediate sub-directory's SKILL.md, stamping source + baseDir", async () => {
    const root = freshRoot();
    const alphaDir = writeSkill(root, "alpha", skillMd("alpha", "Alpha skill"));
    writeSkill(root, "beta", skillMd("beta", "Beta skill"));
    const skills = await loadSkillsFromDirectory(root, "workspace");
    expect(skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    const alpha = skills.find((s) => s.name === "alpha");
    expect(alpha?.sourceInfo).toMatchObject({ baseDir: alphaDir, source: "workspace" });
    expect(alpha?.description).toBe("Alpha skill");
  });

  it("returns [] for a non-existent root (never throws)", async () => {
    expect(await loadSkillsFromDirectory(join(freshRoot(), "does-not-exist"), "user")).toEqual([]);
  });

  it("skips a sub-directory that has no SKILL.md (assets-only folder)", async () => {
    const root = freshRoot();
    writeSkill(root, "real", skillMd("real", "Real skill"));
    writeSkill(root, "assets-only", null); // dir exists, no SKILL.md
    const skills = await loadSkillsFromDirectory(root, "user");
    expect(skills.map((s) => s.name)).toEqual(["real"]);
  });

  it("is FAIL-OPEN: a malformed SKILL.md is logged + skipped, the rest still load", async () => {
    const root = freshRoot();
    writeSkill(root, "good", skillMd("good", "Good skill"));
    writeSkill(root, "bad", "---\ndescription: has no name\n---\nbody"); // missing required name → SkillParseError
    const logs: string[] = [];
    const skills = await loadSkillsFromDirectory(root, "user", (m) => logs.push(m));
    expect(skills.map((s) => s.name)).toEqual(["good"]); // the bad one didn't take the good one down
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("skipping malformed skill");
    expect(logs[0]).toContain(join(root, "bad", "SKILL.md"));
  });

  it("does not throw when no logger is injected and a skill is malformed (default no-op logger)", async () => {
    const root = freshRoot();
    writeSkill(root, "bad", "---\nname:\ndescription:\n---\nx"); // empty name + description
    await expect(loadSkillsFromDirectory(root, "user")).resolves.toEqual([]);
  });
});

describe("FileSystemSkillLoader.loadAll", () => {
  it("merges skills across roots and sorts by name", async () => {
    const userRoot = freshRoot();
    const wsRoot = freshRoot();
    writeSkill(userRoot, "gamma", skillMd("gamma", "Gamma"));
    writeSkill(userRoot, "alpha", skillMd("alpha", "Alpha"));
    writeSkill(wsRoot, "beta", skillMd("beta", "Beta"));
    const loader = new FileSystemSkillLoader({
      roots: [{ path: userRoot, source: "user" }, { path: wsRoot, source: "workspace" }]
    });
    const all = await loader.loadAll();
    expect(all.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]); // sorted
  });

  it("LATER root wins — a workspace skill shadows a user-global one of the same name", async () => {
    const userRoot = freshRoot();
    const wsRoot = freshRoot();
    writeSkill(userRoot, "deploy", skillMd("deploy", "user-global deploy"));
    writeSkill(wsRoot, "deploy", skillMd("deploy", "workspace deploy override"));
    const loader = new FileSystemSkillLoader({
      roots: [{ path: userRoot, source: "user" }, { path: wsRoot, source: "workspace" }] // low → high precedence
    });
    const all = await loader.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ description: "workspace deploy override", name: "deploy" });
    expect(all[0]?.sourceInfo.source).toBe("workspace"); // the higher-precedence root's copy
  });
});
