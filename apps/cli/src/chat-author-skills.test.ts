import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider } from "@muse/model";
import { describe, expect, it } from "vitest";

import { buildSkillRegistry } from "@muse/autoconfigure";

import type { Skill } from "@muse/skills";
import { createSkillRunTool, type SkillCatalogToolEntry, type SkillRegistryView } from "@muse/tools";

import { applySkillRewardsFromSession, authorSkillsFromSession } from "./chat-author-skills.js";
import { selectRelevantSkills } from "./chat-skills.js";

const stub = (output: string): ModelProvider => ({
  id: "stub",
  async generate() {
    return { id: "r", model: "m", output };
  },
  async listModels() {
    return [];
  },
  async *stream() {}
});

const draftOutput =
  "name: export-then-attach\ndescription: Use when sending a document; convert to PDF before attaching.\nbody:\n1. Convert to PDF.\n2. Attach the PDF.";

const boundaries = [{ tsIso: "2026-05-29T00:00:00.000Z", userId: "stark" }];

const correctedSession = [
  { content: "send the report to my manager", role: "user" as const },
  { content: "I attached the .docx.", role: "assistant" as const },
  { content: "no, that's wrong — always convert to PDF first then attach", role: "user" as const }
];

const readEnvFor = (root: string): (() => NodeJS.ProcessEnv) => () => ({
  HOME: root,
  MUSE_QUALIFICATION_LEARNING_HOLD_FILE: join(root, "qualification-learning-hold.json")
});

describe("authorSkillsFromSession", () => {
  it("stages a skill candidate from a procedural correction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-auth-cli-"));
    const res = await authorSkillsFromSession({
      model: "m",
      modelProvider: stub(draftOutput),
      authoredDir: dir,
      readEnv: readEnvFor(dir),
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession
    });
    expect(res.status).toBe("staged");
    if (res.status === "staged") {
      expect(res.skills[0]).toContain("export-then-attach");
    }
  });

  it("preserves explicit owner-triggered active authoring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-auth-cli-explicit-"));
    const res = await authorSkillsFromSession({
      authoredDir: dir,
      destination: "active",
      model: "m",
      modelProvider: stub(draftOutput),
      readEnv: readEnvFor(dir),
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession
    });

    expect(res.status).toBe("authored");
    const registry = await buildSkillRegistry({
      MUSE_AUTHORED_SKILLS_DIR: dir,
      MUSE_SKILLS_DIR: join(dir, "user")
    } as unknown as Parameters<typeof buildSkillRegistry>[0]);
    expect(registry!.get("export-then-attach")).toBeDefined();
  });

  it("skips when there is no correction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-auth-cli-"));
    const res = await authorSkillsFromSession({
      model: "m",
      modelProvider: stub(draftOutput),
      authoredDir: dir,
      readEnv: readEnvFor(dir),
      readBoundaries: async () => boundaries,
      readLines: async () => [
        { content: "send the report", role: "user" },
        { content: "done", role: "assistant" },
        { content: "thanks!", role: "user" }
      ]
    });
    expect(res.status).toBe("skipped");
  });

  it("skips (fail-soft) when history read throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-auth-cli-"));
    const res = await authorSkillsFromSession({
      model: "m",
      modelProvider: stub(draftOutput),
      authoredDir: dir,
      readEnv: readEnvFor(dir),
      readBoundaries: async () => boundaries,
      readLines: async () => {
        throw new Error("disk gone");
      }
    });
    expect(res.status).toBe("skipped");
  });

  it("end-to-end: a staged skill is not loaded or selected next session", async () => {
    const base = mkdtempSync(join(tmpdir(), "muse-auth-e2e-"));
    const authoredDir = join(base, "authored");
    const userDir = join(base, "user");

    const authoring = await authorSkillsFromSession({
      model: "m",
      modelProvider: stub(draftOutput),
      authoredDir,
      readEnv: readEnvFor(base),
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession
    });
    expect(authoring.status).toBe("staged");

    // Next session: the registry loader must ignore probation candidates.
    const registry = await buildSkillRegistry({
      MUSE_SKILLS_DIR: userDir,
      MUSE_AUTHORED_SKILLS_DIR: authoredDir
    } as unknown as Parameters<typeof buildSkillRegistry>[0]);
    const all = registry!.list();
    expect(all.map((s) => s.name)).not.toContain("export-then-attach");

    // A similar request cannot surface a candidate before explicit promotion.
    const relevant = selectRelevantSkills(all, "send my quarterly report to my manager as a document");
    expect(relevant.map((s) => s.name)).not.toContain("export-then-attach");
  });

  // Skill authoring is ON BY DEFAULT (MUSE_SKILL_AUTHOR_ENABLED unset ⇒ true).
  // A model-authored candidate must remain absent from every active surface
  // until a separate, explicit promotion path admits it.
  it("safety invariant: a default-on candidate is absent from muse.skills.run", async () => {
    const base = mkdtempSync(join(tmpdir(), "muse-auth-safety-"));
    const authoredDir = join(base, "authored");
    const userDir = join(base, "user");

    // No MUSE_SKILL_AUTHOR_ENABLED override here — this call is exactly what the
    // pipeline now makes on an unset (default-on) env.
    const authoring = await authorSkillsFromSession({
      model: "m",
      modelProvider: stub(draftOutput),
      authoredDir,
      readEnv: readEnvFor(base),
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession
    });
    expect(authoring.status).toBe("staged");

    const registry = await buildSkillRegistry({
      MUSE_SKILLS_DIR: userDir,
      MUSE_AUTHORED_SKILLS_DIR: authoredDir
    } as unknown as Parameters<typeof buildSkillRegistry>[0]);
    expect(registry!.get("export-then-attach")).toBeUndefined();

    // Same registry-view mapping the real runtime wires (skills-runtime.ts) —
    // exercised here directly against `muse.skills.run`.
    const view: SkillRegistryView = {
      get: (name): SkillCatalogToolEntry | undefined => {
        const found = registry!.get(name);
        return found
          ? {
              body: found.body,
              description: found.description,
              name: found.name,
              ...(found.frontmatter.requires?.anyBins ? { requiresAnyBins: [...found.frontmatter.requires.anyBins] } : {}),
              ...(found.frontmatter.requires?.bins ? { requiresBins: [...found.frontmatter.requires.bins] } : {})
            }
          : undefined;
      },
      list: () => []
    };
    const runTool = createSkillRunTool(view);
    const result = (await runTool.execute(
      { command: "rm -rf /", name: "export-then-attach" },
      { runId: "r-1" }
    )) as { readonly error?: string };
    expect(result.error).toMatch(/skill not found/u);
  });
});

describe("applySkillRewardsFromSession — RL reward over authored skills", () => {
  const mkSkill = (name: string, description: string): Skill =>
    ({ name, description, body: "b", frontmatter: { name, description }, sourceInfo: { source: "authored", filePath: `/s/${name}/SKILL.md`, baseDir: `/s/${name}` } } as unknown as Skill);
  const reportSkill = mkSkill("send-report", "Use when sending a report or document to someone.");
  const blogSkill = mkSkill("blog-writer", "Use when drafting a blog post.");
  const rewardsFile = () => join(mkdtempSync(join(tmpdir(), "muse-skrw-")), "skill-rewards.json");

  it("decays the skill that applied to a corrected request; an unrelated one is untouched", async () => {
    const { readSkillRewards } = await import("@muse/stores");
    const file = rewardsFile();
    const res = await applySkillRewardsFromSession({
      listSkills: async () => [reportSkill, blogSkill],
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession, // request "send the report to my manager" → corrected
      rewardsFile: file
    });
    expect(res.decayed.map((d) => d.name)).toEqual(["send-report"]);
    const rewards = await readSkillRewards(file);
    expect(rewards["send-report"]).toBe(-1);
    expect(rewards["blog-writer"]).toBeUndefined();
  });

  it("reinforces the skill that applied to an approved request", async () => {
    const { readSkillRewards } = await import("@muse/stores");
    const file = rewardsFile();
    const res = await applySkillRewardsFromSession({
      listSkills: async () => [reportSkill, blogSkill],
      readBoundaries: async () => boundaries,
      readLines: async () => [
        { content: "send the report to my manager", role: "user" as const },
        { content: "Converted to PDF and attached.", role: "assistant" as const },
        { content: "perfect, exactly right", role: "user" as const }
      ],
      rewardsFile: file
    });
    expect(res.reinforced.map((r) => r.name)).toEqual(["send-report"]);
    expect((await readSkillRewards(file))["send-report"]).toBe(1);
  });

  it("a bare acknowledgement is neither a correction nor an approval — no change", async () => {
    const file = rewardsFile();
    const res = await applySkillRewardsFromSession({
      listSkills: async () => [reportSkill],
      readBoundaries: async () => boundaries,
      readLines: async () => [
        { content: "send the report", role: "user" as const },
        { content: "done", role: "assistant" as const },
        { content: "thanks", role: "user" as const }
      ],
      rewardsFile: file
    });
    expect(res).toEqual({ decayed: [], reinforced: [] });
  });
});
