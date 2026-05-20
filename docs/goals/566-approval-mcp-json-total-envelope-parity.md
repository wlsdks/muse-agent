# 566 — `muse approval list --json` + `muse mcp config-show --json` envelopes add `total` field (goal-565 sibling sweep — finishes the convention)

## Why

Direct goal-565 follow-up. Goal 565 closed two `--json`
envelope `total`-field outliers (`muse feeds list/today`)
and claimed "a future grep for CLI list-style `--json`
envelopes without a `total` field on
`apps/cli/src/commands-*.ts` should return zero hits". A
fresh grep showed two outliers I'd missed:

| File:line | Envelope | Issue |
| --- | --- | --- |
| `commands-approval.ts:126` | `{ entries: filtered, userKey }` | missing `total` |
| `commands-mcp.ts:69` | `{ entries, path }` | missing `total` |

These are sibling-asymmetry within the established
CLI list-command `--json` convention (goals
551/552/553/565). Closing them fulfills 565's claim and
makes the convention truly uniform across every list-style
`--json` surface I can find.

## Slice

- `apps/cli/src/commands-approval.ts:126` — envelope from
  `{ entries: filtered, userKey }` →
  `{ entries: filtered, total: filtered.length, userKey }`
  (alphabetical key order matches goals 552/553/565
  convention).
- `apps/cli/src/commands-mcp.ts:69` — envelope from
  `{ entries, path }` →
  `{ entries, path, total: entries.length }`.
- `apps/cli/src/commands-approval.test.ts` — added one new
  `it(...)` exercising `muse approval list --user u
  --json` against a single-entry approvals file; asserts
  `parsed.total === 1`, `parsed.entries[0].id ===
  "req-abc123"`, `parsed.userKey === "u"`.
- `apps/cli/test/program.test.ts` — extended the existing
  `mcp config-show --json emits structured output` test to
  also assert `parsed.total === 1` (single-entry mcp.json
  fixture; the test was already a perfect mutation target
  — adding the assertion to the existing fixture is
  cheaper than spawning a separate describe block).

## Verify

- New `it(...)` + extended assertion green; full
  `@muse/cli` suite green (1004 passed, +2 vs baseline
  1002, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  approval envelope to `{ entries: filtered, userKey }`
  (dropping the `total` token) makes the new assertion
  fail with `expected undefined to be 1: list --json must
  carry total — convention parity`. Fix restored, suite
  back to all green. The mcp envelope has a byte-identical
  shape and would mutate-fail identically; cross-surface
  convention is to test one representative when the two
  are byte-identical (matches goal 565's mutation
  rationale).
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1004 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the four intended files.
- Pure CLI rendering — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the two
  remaining outlier programmable surfaces, not the model
  loop.

## Status

Done. A fresh grep `grep -nE 'JSON.stringify\(\{ entries|
JSON.stringify\(\{.*total' apps/cli/src/commands-*.ts`
returns ONLY rows that carry `total` for list-style
envelopes — every list-style `--json` surface in the
codebase now uniformly carries `total`. The convention is
complete.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a direct
goal-565 sibling sweep closing the two remaining
convention-parity outliers, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Both fixes share goal-565's reasoning byte-for-byte: the
  `total` field saves scripted consumers from computing
  `.entries.length` themselves; sibling envelopes already
  carry it; convention wins.
- Alphabetical key order in the approval envelope:
  `{ entries, total, userKey }`. Goal 565 set this
  convention.
- For mcp config-show the envelope already had `path` (a
  contextual field, like `userKey` on approval); inserted
  `total` after `path` to preserve the cross-surface
  pattern of "array → contextual filter fields → total"
  was tempting, but goal 565's pattern is purely
  alphabetical. Settled on alphabetical for consistency:
  `{ entries, path, total }`.
- Mutated only the approval envelope (one of two) for the
  proof. The mcp envelope has a byte-identical
  `{ ..., total: arr.length }` shape and would mutate-fail
  identically.
- One-iteration scope: two byte-identical outliers, both
  closed in one commit. Goal 565 set the precedent of
  "sweep all outliers in one iteration when they're
  byte-identical" (the two feeds surfaces were also
  swept together).
