# 126 — `skill-parser` uses brace-balanced exits for `requires` / `install` blocks

## Why

`parseSkillFrontmatter` had three multi-line block handlers:
`inMetadata` (object), `inRequires` (object), `inInstall`
(array). Only `inMetadata` was refactored (iter 32) to use the
brace-balanced `isJsonBlockComplete` helper. The other two still
exited on the brittle `line.trim() === "}" || line.trim() === "},"`
/ `=== "]" || === "],"` heuristic.

Consequence: a top-level `requires:` block carrying a nested
object (a realistic shape — `{ "matrix": { "darwin": {...} } }`)
exited at the FIRST inner `}`, treating the rest of the outer
object as unrelated frontmatter lines. The outer fields got
silently dropped, and `safeJsonObject` saw a malformed prefix.
Same shape for `install:` arrays with object entries that
themselves carry inner arrays (`args: ["link"]`).

The fix is the contract `isJsonBlockComplete` already exposes:
parameterised open/close characters, depth counter, string-literal
aware. Reusing it for `requires` / `install` closes the
inconsistency the original metadata fix already flagged in
comments.

## Scope

- `packages/skills/src/skill-parser.ts`:
  - `inRequires` exit → `isJsonBlockComplete(requiresJson, "{", "}")`.
  - `inInstall` exit → `isJsonBlockComplete(installJson, "[", "]")`.
  - No call-site changes; the helper was already in the file.

## Verify

- New `packages/skills/test/skill-parser.test.ts` cases:
  - Multi-line `requires:` with nested matrix object → outer
    `matrix.darwin.via` survives + the field below `requires:`
    survives.
  - Multi-line `install:` array with entries carrying inner
    `args: ["link"]` → both entries parse + the field below
    survives.
- `pnpm --filter @muse/skills test` — 10 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — frontmatter parser handles nested JSON in all three
multi-line block kinds the same way.
