import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileSystemSkillLoader,
  parseSkillFile,
  parseSkillFrontmatter,
  SkillParseError
} from "../src/index.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "muse-skills-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const OPENCLAW_STYLE_SKILL = `---
name: github
description: "Use gh for GitHub issues, PR status, CI/logs, comments, reviews."
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "requires": { "bins": ["gh"] },
        "install":
          [
            { "id": "brew", "kind": "brew", "formula": "gh", "bins": ["gh"], "label": "Install GitHub CLI (brew)" }
          ]
      }
  }
---

# GitHub Skill

Use the \`gh\` CLI to interact with GitHub.
`;

const MUSE_STYLE_SKILL = `---
name: codex
description: "Delegate coding tasks to OpenAI Codex CLI via subprocess."
emoji: "🧩"
homepage: "https://github.com/openai/codex"
metadata:
  {
    "muse":
      {
        "requires": { "anyBins": ["codex"] },
        "install":
          [
            { "id": "node", "kind": "node", "package": "@openai/codex", "bins": ["codex"], "label": "Install Codex CLI (npm)" }
          ]
      }
  }
---

# Codex

Run with: \`codex exec 'task description'\`.
`;

describe("parseSkillFrontmatter", () => {
  it("parses OpenClaw-style metadata.openclaw block into requires/install", () => {
    const parsed = parseSkillFrontmatter(`name: github
description: "gh for GitHub"
metadata:
  {
    "openclaw": { "requires": { "bins": ["gh"] }, "install": [{ "id": "brew", "kind": "brew", "label": "Install gh" }] }
  }`);
    expect(parsed.name).toBe("github");
    expect(parsed.description).toBe("gh for GitHub");
    expect(parsed.requires?.bins).toEqual(["gh"]);
    expect(parsed.install?.[0]?.kind).toBe("brew");
  });

  it("parses Muse-style metadata.muse block identically", () => {
    const parsed = parseSkillFrontmatter(`name: codex
description: "Codex CLI"
metadata:
  {
    "muse": { "requires": { "anyBins": ["codex"] }, "install": [{ "id": "node", "kind": "node", "label": "npm install codex" }] }
  }`);
    expect(parsed.requires?.anyBins).toEqual(["codex"]);
    expect(parsed.install?.[0]?.kind).toBe("node");
  });

  it("tolerates empty frontmatter", () => {
    const parsed = parseSkillFrontmatter("");
    expect(parsed).toEqual({ description: "", name: "" });
  });

  it("exits the metadata block at the closing brace so fields below metadata survive (iter 32)", () => {
    // Pre-iter-32 the `inMetadata` flag flipped on at `metadata:` but
    // had NO exit condition — every subsequent line, including
    // unrelated fields like `description` / `emoji` / `homepage`,
    // was appended to `metadataJson`. That broke JSON.parse AND
    // silently lost the trailing fields. (Compare with the
    // `inRequires` / `inInstall` siblings, which DID exit on
    // `line.trim() === "}"`.)
    const parsed = parseSkillFrontmatter(`name: codex
metadata:
  {
    "muse": { "requires": { "anyBins": ["codex"] } }
  }
description: "Codex CLI"
emoji: "🧩"`);
    // metadata still parses
    expect(parsed.requires?.anyBins).toEqual(["codex"]);
    // and the fields BELOW metadata are not lost
    expect(parsed.description).toBe("Codex CLI");
    expect(parsed.emoji).toBe("🧩");
  });
});

describe("parseSkillFile", () => {
  it("round-trips an OpenClaw-format SKILL.md", async () => {
    const skillDir = join(workdir, "github");
    await mkdir(skillDir);
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(skillPath, OPENCLAW_STYLE_SKILL, "utf8");
    const skill = await parseSkillFile(skillPath, { source: "user" });
    expect(skill.name).toBe("github");
    expect(skill.description).toContain("Use gh for GitHub");
    expect(skill.body).toContain("# GitHub Skill");
    expect(skill.frontmatter.requires?.bins).toEqual(["gh"]);
    expect(skill.sourceInfo.source).toBe("user");
    expect(skill.sourceInfo.filePath).toBe(skillPath);
  });

  it("throws on missing name", async () => {
    const skillPath = join(workdir, "broken.md");
    await writeFile(skillPath, `---
description: "no name"
---

body`, "utf8");
    await expect(parseSkillFile(skillPath, { source: "user" })).rejects.toBeInstanceOf(SkillParseError);
  });
});

describe("FileSystemSkillLoader", () => {
  it("loads every skill directory, last root wins on name conflict", async () => {
    const userRoot = join(workdir, "user");
    const workspaceRoot = join(workdir, "workspace");
    await mkdir(join(userRoot, "github"), { recursive: true });
    await writeFile(join(userRoot, "github", "SKILL.md"), OPENCLAW_STYLE_SKILL, "utf8");
    await mkdir(join(userRoot, "codex"), { recursive: true });
    await writeFile(join(userRoot, "codex", "SKILL.md"), MUSE_STYLE_SKILL, "utf8");
    await mkdir(join(workspaceRoot, "codex"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "codex", "SKILL.md"),
      `---
name: codex
description: "workspace override of codex"
---

# Local override`,
      "utf8"
    );

    const loader = new FileSystemSkillLoader({
      roots: [
        { path: userRoot, source: "user" },
        { path: workspaceRoot, source: "workspace" }
      ]
    });
    const skills = await loader.loadAll();
    expect(skills.map((skill) => skill.name)).toEqual(["codex", "github"]);
    const codex = skills.find((skill) => skill.name === "codex");
    expect(codex?.description).toBe("workspace override of codex");
    expect(codex?.sourceInfo.source).toBe("workspace");
  });

  it("returns empty when root does not exist", async () => {
    const loader = new FileSystemSkillLoader({ roots: [{ path: join(workdir, "missing"), source: "user" }] });
    expect(await loader.loadAll()).toHaveLength(0);
  });
});
