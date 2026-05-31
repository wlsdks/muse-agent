import { describe, expect, it } from "vitest";

import { buildSkillsPrompt, selectRelevantSkills } from "./chat-skills.js";
import type { Skill } from "@muse/skills";

function skill(name: string, description: string, body: string): Skill {
  return {
    name,
    description,
    body,
    frontmatter: { name, description },
    sourceInfo: { source: "user", filePath: `/s/${name}/SKILL.md`, baseDir: `/s/${name}` }
  } as unknown as Skill;
}

const blog = skill("blog-writer", "Use when the user wants to draft a blog post or article.", "BODY: structure the blog post with a hook, body, CTA.");
const refactor = skill("refactor-helper", "Use when refactoring TypeScript code for clarity.", "BODY: extract functions, name well, keep behavior.");

describe("selectRelevantSkills", () => {
  it("selects the skill whose name/description shares a content word with the prompt", () => {
    const picked = selectRelevantSkills([blog, refactor], "help me write a blog post about ramen");
    expect(picked.map((s) => s.name)).toEqual(["blog-writer"]);
  });
  it("returns nothing when no content word overlaps (generic stopwords don't match)", () => {
    expect(selectRelevantSkills([blog, refactor], "what is the weather today?")).toEqual([]);
    // "use"/"the"/"user" are stopwords — a prompt full of them matches nothing
    expect(selectRelevantSkills([blog, refactor], "can you use the thing")).toEqual([]);
  });
  it("caps the number of bodied skills", () => {
    expect(selectRelevantSkills([blog, refactor], "blog refactor", 1)).toHaveLength(1);
  });
});

describe("buildSkillsPrompt — per-turn ITR exposure", () => {
  it("injects the body for the RELEVANT skill but only an index line for the rest", () => {
    const out = buildSkillsPrompt([blog, refactor], "draft a blog post");
    expect(out).toContain("### blog-writer");
    expect(out).toContain("BODY: structure the blog post"); // relevant → body present
    expect(out).toContain("### refactor-helper");
    expect(out).toContain("Use when refactoring");          // discoverable…
    expect(out).not.toContain("extract functions");          // …but its body is withheld
  });
  it("with no relevant skill, every skill is index-only (bodies withheld) — discoverability kept", () => {
    const out = buildSkillsPrompt([blog, refactor], "what's the weather?");
    expect(out).toContain("### blog-writer");
    expect(out).toContain("### refactor-helper");
    expect(out).not.toContain("BODY:");
  });
  it("empty skill set → empty string", () => {
    expect(buildSkillsPrompt([], "anything")).toBe("");
  });

  it("fires onSelected for each body-injected skill, not for index-only ones", () => {
    const fired: string[] = [];
    buildSkillsPrompt([blog, refactor], "draft a blog post", (s) => fired.push(s.name));
    expect(fired).toEqual(["blog-writer"]);
  });

  it("fires onSelected for nothing when no skill matches", () => {
    const fired: string[] = [];
    buildSkillsPrompt([blog, refactor], "what is the weather today", (s) => fired.push(s.name));
    expect(fired).toEqual([]);
  });
});

describe("RL avoidance — a corrected-into-the-floor skill is dropped", () => {
  it("selectRelevantSkills excludes an avoided skill but keeps the rest", () => {
    const picked = selectRelevantSkills([blog, refactor], "draft a blog post and refactor the code", 2, (n) => n === "blog-writer");
    expect(picked.map((s) => s.name)).toEqual(["refactor-helper"]); // blog-writer would match but is avoided
  });

  it("buildSkillsPrompt drops an avoided skill entirely — not even an index line", () => {
    const out = buildSkillsPrompt([blog, refactor], "draft a blog post", undefined, (name) => name === "blog-writer");
    expect(out).not.toContain("blog-writer"); // gone from the prompt, body and index alike
    expect(out).toContain("### refactor-helper"); // the rest stays discoverable
  });
});

describe("RL reward-weighted ordering — a proven skill wins the limited slots", () => {
  const alpha = skill("blog-alpha", "Use when writing a blog post.", "BODY alpha");
  const bravo = skill("blog-bravo", "Use when writing a blog post.", "BODY bravo");

  it("among equally-relevant skills, the higher-reward one is selected first (overrides the name tie-break)", () => {
    const reward = (n: string): number => (n === "blog-bravo" ? 4 : 0);
    expect(selectRelevantSkills([alpha, bravo], "write a blog post", 1, undefined, reward).map((s) => s.name)).toEqual(["blog-bravo"]);
    // …and without reward the name tie-break would have picked alpha
    expect(selectRelevantSkills([alpha, bravo], "write a blog post", 1).map((s) => s.name)).toEqual(["blog-alpha"]);
  });

  it("reward does NOT make an irrelevant skill relevant — the overlap gate stays", () => {
    const vpn = skill("vpn-fix", "Fix a flaky WireGuard tunnel.", "B");
    const reward = (n: string): number => (n === "vpn-fix" ? 5 : 0);
    expect(selectRelevantSkills([blog, vpn], "write a blog post", 2, undefined, reward).map((s) => s.name)).toEqual(["blog-writer"]);
  });
});
