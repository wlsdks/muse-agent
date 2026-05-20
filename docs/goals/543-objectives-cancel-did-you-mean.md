# 543 — `muse objectives cancel <id>` adds a did-you-mean hint on a near-miss typo (goal-153/468/535 sibling)

## Why

`apps/cli/src/commands-objectives.ts:106` printed an opaque
`no objective with id '<id>'` error when the cancel id didn't
match any existing objective:

```ts
if (!patched) {
  io.stderr(`no objective with id '${id}'\n`);
  command.error("objectives cancel failed", { exitCode: 1 });
  return;
}
```

A user typing `muse objectives cancel obj_f9e09df1-4bcc-409x`
(one-character typo on the trailing char of an objective id —
a common copy-paste glitch) got the same opaque error as
`muse objectives cancel abracadabra`. The codebase already
has the `closestCommandName` Levenshtein helper used by:
- `muse feeds remove`/`refresh` (153)
- `muse jobs list --status` (151)
- `muse approve <id>` / `muse deny <id>` (472-476)
- `muse config set <key>` (535)
- … and a dozen other enum-style flags

…but `muse objectives cancel` was the remaining outlier
without the typo-hint convention. Especially confusing because
objective ids are UUID-shaped (32+ chars) — one-character
typos are the dominant error mode.

## Slice

- `apps/cli/src/commands-objectives.ts` — read the existing
  objectives, run `closestCommandName(id.trim(), known)`, and
  append ` — did you mean '<suggestion>'?` to the stderr line
  when there's a close match. Same shape as the cross-CLI
  convention.
- `apps/cli/src/commands-objectives.test.ts` — added one new
  `it(...)` test:
  - register a fresh objective via `muse objectives add`
  - parse the generated `obj_<uuid>` id from stdout
  - run `muse objectives cancel <typo>` (one-char mutation on
    the trailing char)
  - assert stderr contains the bad id verbatim AND the
    `did you mean '<real-id>'` hint
  - assert exit code 1

## Verify

- New test 1/1 green; full `@muse/cli` suite green (934
  passed, +2 vs baseline 932, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  hint logic back to the pre-fix single-line stderr makes
  the new test fail with the precise pre-fix symptom —
  `expected 'no objective with id \\'obj_f9e09df1-…\\'' to
  contain 'did you mean \\'obj_f9e09df1-…\\''`. Fix restored,
  suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI error-message helper — no LLM request-response
  wire path; `smoke:live` does not apply (per `testing.md`
  / iteration-loop Step 9). The defended path is the
  `muse objectives cancel` error surface, not the model
  loop.

## Status

Done. `muse objectives cancel <typo>` now produces:

```
no objective with id 'obj_f9e09df1-...x' — did you mean 'obj_f9e09df1-...e'?
```

…instead of the opaque `no objective with id '<typo>'`.
The CLI did-you-mean convention now reads identically across
every command-id surface in the codebase:

- `muse feeds {remove,refresh} --id` (153)
- `muse jobs list --status` (151)
- `muse approve <id>` / `muse deny <id>` (472-476)
- `muse config set <key>` (535)
- `muse objectives cancel <id>` (this goal)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a CLI-ergonomics polish `fix:`
on `muse objectives cancel`, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Step-8 redirect from the cosine-NaN sweep (541/542) to a
  CLI UX polish on a different surface. Productive
  variation, not same-area churn.
- Used `closestCommandName(id.trim(), known)` matching the
  cross-CLI convention shape. `known` is the list of
  existing objective ids freshly read from the file (not
  cached) — the cancel path is one-shot anyway, so the
  extra read is acceptable cost for accurate suggestions
  even after concurrent edits.
- Built the test by parsing the generated `obj_<uuid>` id
  out of `muse objectives add`'s stdout (`/(obj_[a-z0-9-]+)/u`).
  This is deterministic-enough because the test fixture
  isolates `MUSE_OBJECTIVES_FILE` per test; no
  cross-contamination of ids.
- The one-character typo mutation (`${realId.slice(0, -1)}x`)
  is one edit-distance from the real id — well within the
  Levenshtein cap for 30+ char inputs (length-aware cap = 3
  edits for ≥8-char strings). The hint will reliably fire.
- The mutation reverts the 4-line hint block to the pre-fix
  one-liner; the test failure (`expected ... to contain
  'did you mean'`) reproduces the pre-fix observable
  byte-for-byte.
