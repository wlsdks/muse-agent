# 140 — `muse search --to-notes` scrubs result title + snippet before write

## Why

`muse search --to-notes <path>` persists search results
(title / URL / snippet) as a markdown note under
`MUSE_NOTES_DIR`. The title and snippet come from **external
search backends** (SearXNG, DuckDuckGo), and indexed forum
posts / API docs / leak announcements regularly quote real
credential shapes (`ghp_…`, `sk-proj-…`). Persisting those
verbatim would land them in:

- the local notes folder (long-lived),
- whatever third-party sync the user has on top (iCloud,
  Obsidian Sync, Notion, git).

Same risk-class as goal 112 (`muse today --save-to-notes`):
long-lived persistence + opaque third-party sync.

## Scope

- `apps/cli/src/commands-search.ts` `--to-notes` branch:
  - Run `r.title` and `r.snippet` through
    `redactSecretsInText` before composing the markdown body.
  - URLs stay verbatim. They're clickable identifiers and the
    existing patterns don't target `?api_key=…` URL params
    anyway — mangling a URL would break the note's utility.
- On-screen rendering keeps the existing
  `stripUntrustedTerminalChars` (the credential strings are not
  control characters; the two filters are complementary).

## Verify

- New `apps/cli/test/program.test.ts` case:
  - Fake DuckDuckGo backend whose title carries
    `ghp_…` and snippet carries `sk-proj-…`.
  - `muse search --to-notes research/keys.md` runs against the
    fake.
  - Assert: written `.md` file contains `[redacted-openai-key]`
    + `[redacted-github-pat]`, NOT the verbatim shapes;
    surrounding prose + URL survive; `# Search:` heading present.
- `pnpm --filter @muse/cli test` — 357 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — `muse search --to-notes` joins the credential-hygiene
line of goals 086 / 107 / 108 / 109 / 111 / 112 / 116 / 138 /
139. The remaining long-lived on-disk Muse artifacts that hold
external-text are now all redacted at the write boundary.
