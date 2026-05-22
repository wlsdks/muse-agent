# 727 — test: pin the empty-custom-preamble fall-through in resolveActivePersonaPreamble

## Why

`resolveActivePersonaPreamble` guards `custom && custom.preamble.length
> 0` before returning a custom persona's preamble — so a custom entry
whose preamble is the empty string is treated as "not set" and falls
through to the built-in (for a built-in id) or to `""`. The existing
persona tests cover the prototype-pollution guard, stale/unknown ids,
and a NON-empty custom override, but never the empty-string-preamble
branch — a regression that dropped `.length > 0` (returning `""` for a
blank `jarvis` override) would silently strip the JARVIS voice with no
test catching it. This was the only genuinely-uncovered branch found
this tick after confirming PDF parsing, reindex fail-soft, slugify, the
followup detector, token-trim tool-pairing, reminders due-filtering, and
the persona prototype-pollution guard are all already robust + covered.

## Slice

- `apps/cli/test/program.test.ts`: extend the existing persona
  Object.prototype test with two assertions —
  - `{activeId:"jarvis", custom:{jarvis:{preamble:""}}}` → still the
    built-in JARVIS preamble (an empty override can't blank the voice);
  - `{activeId:"blank", custom:{blank:{preamble:""}}}` → `""` (a
    custom-only id with an empty preamble yields no preamble).

## Verify

- `@muse/cli` program.test.ts (1267 tests) passes.
- **Mutation-proven**: weakening the guard to `if (custom) return
  custom.preamble` (dropping `.length > 0`) fails the new jarvis-empty
  assertion. Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0.
- No source change — pure coverage of an existing correct branch; no LLM
  path, no CAPABILITIES line.

## Decisions

- **Extended the existing persona test, didn't add a redundant one** — I
  first drafted a separate test but found it duplicated the already-
  thorough prototype-pollution coverage (loop rule 4 bans already-covered
  tests); only the empty-preamble branch was genuinely missing, so it
  rides on the existing test as two assertions.
- **Next tick: the REMOTE approve-completion round-trip deserves its own
  full tick** — the easy polish/bug surfaces are now exhausted; the
  round-trip is the highest-value remaining work but is multi-component +
  safety-critical, so it should be started fresh with full budget, not
  rushed at the tail of a tick.
