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
});
