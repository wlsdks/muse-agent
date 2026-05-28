/**
 * `@muse/skills` — SKILL.md-based external-tool integration
 * (inspired by Anthropic Skills / OpenClaw skill directories).
 *
 * A Skill is a single `SKILL.md` file with a JSON / YAML-ish
 * frontmatter block and a markdown body. The frontmatter carries
 * routing metadata (name, description, requires.bins, install
 * hints); the body is free-form *instructions for the LLM* on
 * how to use the underlying tool — typically an external CLI like
 * `codex`, `claude`, `gh`, `gemini`, etc.
 *
 * Two layers coexist with Muse's typed `MuseToolDefinition` + MCP
 * surface: SKILL.md is the fast / instructions-only path that
 * doesn't require schema authoring.
 */

export {
  type Skill,
  type SkillFrontmatter,
  type SkillInstallStep,
  type SkillRequires,
  type SkillSource,
  type SkillSourceInfo
} from "./skill-contract.js";

export {
  parseSkillFile,
  parseSkillFrontmatter,
  SkillParseError
} from "./skill-parser.js";

export {
  FileSystemSkillLoader,
  loadSkillsFromDirectory,
  type FileSystemSkillLoaderOptions
} from "./skill-loader.js";

export {
  InMemorySkillRegistry,
  type SkillRegistry
} from "./skill-registry.js";

export {
  AuthoredSkillStore,
  serializeAuthoredSkill,
  slugifySkillName,
  DEFAULT_MAX_AUTHORED_SKILLS,
  type SkillDraft,
  type AuthorAction,
  type AuthoredSkillStoreOptions
} from "./authored-skill-store.js";
