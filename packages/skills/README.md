# @muse/skills

Owns Muse's `SKILL.md`-based external-tool integration (inspired by Anthropic Skills / OpenClaw
skill directories): parsing a skill file's frontmatter + instructions body, loading skills from a
directory, and the authored-skill store that lets Muse write, evict, and risk-scan its own
skills. It is a package rather than a folder because a skill is a second, lighter-weight
integration surface next to Muse's typed `MuseToolDefinition`/MCP tools, and needs its own
parse/load/store contract that both paths can share.

## Public surface

- `Skill`, `SkillFrontmatter`, `SkillRequires`, `SkillSource`, `SkillInstallStep` — the parsed
  skill shape: routing metadata plus the free-form instruction body.
- `parseSkillFile`, `parseSkillFrontmatter`, `SkillParseError` — frontmatter/body parsing.
- `FileSystemSkillLoader`, `loadSkillsFromDirectory` — loads all `SKILL.md` files under a directory.
- `InMemorySkillRegistry`, `SkillRegistry` — the in-memory skill lookup surface.
- `AuthoredSkillStore`, `SkillDraft`, `AuthorAction`, `ActiveSkillWriteBlockedError`,
  `FAIL_CLOSED_ACTIVE_SKILL_WRITE_GATE` — Muse's own skill-authoring store, its fail-closed write
  gate, and eviction ranking (`rankSkillsForEviction`, `DEFAULT_MAX_AUTHORED_SKILLS`).
- `scanSkillBodyForRisks`, `SkillRiskScan` — deterministic risk scan of an authored skill body
  before it can be activated.
- `skillBodyIsSubsumed`, `slugifySkillName`, `serializeAuthoredSkill` — supporting authoring helpers.

## Depends on

- `@muse/shared` — common primitives.

## Rules that bind this package

A `SKILL.md` body is free-form text that an LLM will read and follow, typically instructing an
external CLI (`codex`, `claude`, `gh`, `gemini`) — treat an authored or loaded skill body as
untrusted content per [`../../CLAUDE.md`](../../CLAUDE.md)'s "tool output is untrusted" principle,
which is why `scanSkillBodyForRisks` and `FAIL_CLOSED_ACTIVE_SKILL_WRITE_GATE` exist: an authored
skill fails closed rather than silently activating unscanned instructions.

## Tests

```bash
pnpm --filter @muse/skills test
```
