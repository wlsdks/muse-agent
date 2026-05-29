import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseSkillFile } from "../src/skill-parser.js";
import { AuthoredSkillStore, serializeAuthoredSkill, slugifySkillName } from "../src/authored-skill-store.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-authored-"));
}

describe("AuthoredSkillStore — create + execute-gate", () => {
  it("writes a parseable SKILL.md and tags it authored", async () => {
    const dir = tmpDir();
    const store = new AuthoredSkillStore({ dir, now: () => new Date("2026-05-29T00:00:00Z") });
    const res = await store.writeOrPatch({
      name: "summarise-with-bullets",
      description: "Use when the user asks for a summary; produce bullet points not prose.",
      body: "## Steps\n1. Read the source.\n2. Emit 3-5 bullets."
    });
    expect(res.action).toBe("create");
    const parsed = await parseSkillFile(res.skill.sourceInfo.filePath, { source: "authored" });
    expect(parsed.name).toBe("summarise-with-bullets");
    expect(parsed.frontmatter.metadata?.muse).toMatchObject({ authored: true });
  });

  it("NEVER emits requires — the execute-gate is structural", async () => {
    const dir = tmpDir();
    const store = new AuthoredSkillStore({ dir });
    const res = await store.writeOrPatch({
      name: "danger",
      description: "requires gh and rm; bins: [rm]",
      body: "requires:\n  bins: [rm]\nrun rm -rf"
    });
    const parsed = await parseSkillFile(res.skill.sourceInfo.filePath, { source: "authored" });
    expect(parsed.frontmatter.requires).toBeUndefined();
  });

  it("slugifies names safely", () => {
    expect(slugifySkillName("Summarise With Bullets!")).toBe("summarise-with-bullets");
    expect(slugifySkillName("   ")).toBe("skill");
  });

  it("serializeAuthoredSkill round-trips through the parser", () => {
    const text = serializeAuthoredSkill({ name: "n", description: "d", body: "B" }, "2026-05-29T00:00:00Z");
    expect(text).toContain("name: n");
    expect(text).toContain('metadata: {"muse":{"authored":true,"authoredAt":"2026-05-29T00:00:00Z"}}');
    expect(text.trimEnd().endsWith("B")).toBe(true);
  });

  it("serializeAuthoredSkill includes lastUsedAt when provided", () => {
    const text = serializeAuthoredSkill(
      { name: "n", description: "d", body: "B" },
      "2026-05-29T00:00:00Z",
      "2026-05-29T12:00:00Z"
    );
    expect(text).toContain('"lastUsedAt":"2026-05-29T12:00:00Z"');
  });
});

describe("AuthoredSkillStore — dedup", () => {
  it("patches an existing similar skill instead of duplicating", async () => {
    const dir = tmpDir();
    const store = new AuthoredSkillStore({ dir });
    const first = await store.writeOrPatch({
      name: "summarise-with-bullets",
      description: "Use when the user asks for a summary; produce bullet points not prose.",
      body: "old body"
    });
    const second = await store.writeOrPatch({
      name: "summarise-with-bullets",
      description: "Use when the user asks for a summary; produce bullet points not prose.",
      body: "new improved body"
    });
    expect(second.action).toBe("patch");
    expect(await store.listAuthored()).toHaveLength(1);
    expect(second.skill.body).toContain("new improved body");
    expect(first.skill.sourceInfo.filePath).toBe(second.skill.sourceInfo.filePath);
  });

  it("skips a byte-identical re-write (idempotent)", async () => {
    const dir = tmpDir();
    const now = (): Date => new Date("2026-05-29T00:00:00Z");
    const store = new AuthoredSkillStore({ dir, now });
    const draft = { name: "a", description: "d", body: "B" };
    await store.writeOrPatch(draft);
    const again = await store.writeOrPatch(draft);
    expect(again.action).toBe("skip");
  });
});

describe("AuthoredSkillStore — cap & collisions", () => {
  it("archives the oldest when over cap, never deletes", async () => {
    const dir = tmpDir();
    let t = 0;
    const store = new AuthoredSkillStore({
      dir,
      maxSkills: 2,
      now: () => new Date(1_700_000_000_000 + (t += 1000))
    });
    await store.writeOrPatch({ name: "one", description: "alpha topic", body: "1" });
    await store.writeOrPatch({ name: "two", description: "beta topic", body: "2" });
    await store.writeOrPatch({ name: "three", description: "gamma topic", body: "3" });
    const live = await store.listAuthored();
    expect(live.map((s) => s.name).sort()).toEqual(["three", "two"]);
    const { readdir } = await import("node:fs/promises");
    const archived = await readdir(join(dir, ".archive")).catch(() => [] as string[]);
    expect(archived).toContain("one");
  });

  it("suffixes a name that collides with a non-authored skill", async () => {
    const dir = tmpDir();
    const store = new AuthoredSkillStore({ dir, existingNames: () => ["pdf"] });
    const res = await store.writeOrPatch({ name: "pdf", description: "x", body: "b" });
    expect(res.skill.name).toBe("pdf-learned");
  });
});

describe("AuthoredSkillStore — recordUsage", () => {
  it("stamps lastUsedAt on an authored skill", async () => {
    const dir = tmpDir();
    const store = new AuthoredSkillStore({ dir, now: () => new Date("2026-05-29T00:00:00Z") });
    await store.writeOrPatch({ name: "bullet-summary", description: "Use for summaries", body: "steps" });

    const storeAt = new AuthoredSkillStore({ dir, now: () => new Date("2026-05-29T10:00:00Z") });
    const updated = await storeAt.recordUsage("bullet-summary");
    expect(updated).toBe(true);

    const [skill] = await storeAt.listAuthored();
    const muse = skill?.frontmatter.metadata?.["muse"] as Record<string, unknown> | undefined;
    expect(muse?.lastUsedAt).toBe("2026-05-29T10:00:00.000Z");
    expect(muse?.authoredAt).toBe("2026-05-29T00:00:00.000Z");
  });

  it("returns false for a skill that does not exist", async () => {
    const dir = tmpDir();
    const store = new AuthoredSkillStore({ dir });
    expect(await store.recordUsage("nonexistent")).toBe(false);
  });

  it("throttles: skips a second recordUsage within 60 seconds", async () => {
    const dir = tmpDir();
    const t0 = new Date("2026-05-29T10:00:00Z");
    const store0 = new AuthoredSkillStore({ dir, now: () => new Date("2026-05-29T00:00:00Z") });
    await store0.writeOrPatch({ name: "throttle-test", description: "d", body: "b" });

    const store1 = new AuthoredSkillStore({ dir, now: () => t0 });
    await store1.recordUsage("throttle-test");

    const t1 = new Date(t0.getTime() + 30_000);
    const store2 = new AuthoredSkillStore({ dir, now: () => t1 });
    const skipped = await store2.recordUsage("throttle-test");
    expect(skipped).toBe(false);

    const [skill] = await store2.listAuthored();
    const muse = skill?.frontmatter.metadata?.["muse"] as Record<string, unknown> | undefined;
    expect(muse?.lastUsedAt).toBe(t0.toISOString());
  });

  it("does NOT throttle after 60 seconds", async () => {
    const dir = tmpDir();
    const t0 = new Date("2026-05-29T10:00:00Z");
    const store0 = new AuthoredSkillStore({ dir, now: () => new Date("2026-05-29T00:00:00Z") });
    await store0.writeOrPatch({ name: "expire-test", description: "d", body: "b" });

    const store1 = new AuthoredSkillStore({ dir, now: () => t0 });
    await store1.recordUsage("expire-test");

    const t1 = new Date(t0.getTime() + 61_000);
    const store2 = new AuthoredSkillStore({ dir, now: () => t1 });
    const updated = await store2.recordUsage("expire-test");
    expect(updated).toBe(true);

    const [skill] = await store2.listAuthored();
    const muse = skill?.frontmatter.metadata?.["muse"] as Record<string, unknown> | undefined;
    expect(muse?.lastUsedAt).toBe(t1.toISOString());
  });
});
