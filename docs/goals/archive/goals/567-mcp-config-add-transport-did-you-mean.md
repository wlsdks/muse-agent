# 567 — `muse mcp config-add --transport <typo>` adds did-you-mean hint (closest-command convention sibling)

## Why

The CLI did-you-mean / closest-command convention (goals 100,
137, 153, 468, 543, 544, 545, and the search `--time` /
orchestrate `--mode` enums) emits an actionable
`— did you mean '<closest>'?` tail on every typo'd enum
validation error. The full coverage as of yesterday:

| Command | Flag | Convention |
| --- | --- | --- |
| `muse remind list` | `--status` | did-you-mean (137) |
| `muse tasks list` | `--status` | did-you-mean (125) |
| `muse history` | `--kind` | did-you-mean |
| `muse search` | `--time` | did-you-mean |
| `muse orchestrate` | `--mode` | did-you-mean |
| `muse objectives add` | `--kind` | did-you-mean |
| `muse actions` | `--result` | did-you-mean |
| `muse persona use` | `<id>` | did-you-mean (100) |
| `muse persona add` | `<id>` collision | rename hint (557) |
| `muse mcp config-add` | `--transport` | **— missing —** |

A user who types `muse mcp config-add x --transport streamble
--url https://e.test/mcp` (typo for `streamable`) pre-fix saw
only:

```
--transport must be 'stdio', 'streamable', or 'sse' (got 'streamble')
```

Three valid values listed but no actionable guess. The
sibling commands all carry the convention; closing this
outlier keeps the CLI typo-tolerance uniform.

## Slice

- `apps/cli/src/commands-mcp.ts:384` — added the same
  closest-command shape every sibling uses:
  ```ts
  const suggestion = closestCommandName(transport, ["stdio", "streamable", "sse"]);
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`--transport must be 'stdio', 'streamable', or 'sse' (got '${transport}')${hint}`);
  ```
  `closestCommandName` was already imported in the file
  (used by `muse mcp use <preset>` typo handling, line 173).
- `apps/cli/test/program.test.ts` — added one `it(...)`
  covering: `streamble` → suggests `streamable`; `sde` →
  suggests `sse`; `totally-unrelated` gets the listing
  only, NO false-positive suggestion. Mirrors the
  goal-137 `muse remind list --status` test shape
  byte-for-byte.

## Verify

- New `it(...)` green; full `@muse/cli` suite green (1005
  passed, +1 vs baseline 1004, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `closestCommandName` + hint logic to the pre-fix bare
  error message makes the new test fail with `typo on
  streamable must surface the actionable suggestion:
  expected ... to contain "did you mean 'streamable'?"`.
  Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1005 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- Pure validation error — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is `muse mcp
  config-add` validation, not the model loop.

## Status

Done. The CLI typo-tolerance convention now reaches the
`muse mcp config-add --transport` enum validation. Every
enum flag I can find on the CLI surface now emits the
actionable closest-command suggestion when the user types a
near-match typo.

A future grep `grep -nE 'must be .* (got' apps/cli/src/
commands-*.ts | grep -v "did you mean"` should narrow to
errors with no useful suggestion candidate set (e.g.
`commands-calendar.ts` "--from / --to must be ISO 8601
timestamps" — there's no closest-ISO-8601 to suggest).

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
convention-parity polish on the existing `muse mcp
config-add` enum validation, recorded honestly with this
backlog row — not a false metric.

## Decisions

- The same `closestCommandName + ternary hint` shape as
  every sibling convention site (`commands-remind.ts:55`,
  `commands-tasks.ts:53`, `commands-history.ts:115`,
  `commands-objectives.ts:36`, `commands-actions.ts:28`,
  `commands-search.ts:94`, `commands-orchestrate.ts:53`).
  Cross-command consistency wins.
- The candidate set is hardcoded `["stdio", "streamable",
  "sse"]` (the three valid transports). Considered passing
  the literal valid-set string back through a constant
  — rejected because the existing convention site
  `commands-remind.ts` passes a literal too; adopting
  identical shape keeps the diff readable.
- The mutation reverts to the pre-fix bare-message form.
  Smallest semantic delta; surgical proof that the hint
  is the load-bearing change.
- The test exercises THREE branches (one-edit typo on
  `streamable`, one-edit typo on `sse`, unrelated input
  that should NOT pull a misleading hint). Same coverage
  shape as goal 137's `muse remind list` test pinning the
  `not.toContain("did you mean")` for the unrelated-input
  case.
- Did NOT change the `--command (stdio) or --url
  (streamable/sse)` error (line 368). That's a "missing
  required argument" error, not an enum-value error; the
  closest-command convention doesn't apply.
- Did NOT touch other CLI errors that lack did-you-mean
  hints when the candidate set is open-ended (e.g.
  `--site must be a bare domain`, `--at must be a
  parseable ISO timestamp`). The convention only applies
  to closed enums.
- Step-8 sub-defect-class check: did-you-mean / closest-
  command convention parity is distinct from the recent
  comparator-determinism (551/555/556), validate-NaN
  (562/563), envelope-parity (565/566), error-UX
  completeness (564), trim-symmetry (559),
  integer-overflow (561). Fresh defect-class slot.
