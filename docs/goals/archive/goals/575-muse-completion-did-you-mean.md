# 575 — `muse completion <typo>` adds did-you-mean hint (closest-command convention sibling)

## Why

The CLI did-you-mean / closest-command convention is uniform
across every enum-style validation site except this one:

| Surface | Coverage |
| --- | --- |
| `muse remind list --status` | did-you-mean (137) |
| `muse tasks list --status` | did-you-mean (125) |
| `muse history --kind` | did-you-mean |
| `muse search --time` | did-you-mean |
| `muse orchestrate --mode` | did-you-mean |
| `muse objectives add --kind` | did-you-mean |
| `muse actions --result` | did-you-mean |
| `muse persona use <id>` | did-you-mean (100) |
| `muse persona add <id>` collision | rename hint (557) |
| `muse mcp config-add --transport` | did-you-mean (567) |
| `muse listen --format` | did-you-mean |
| **`muse completion <shell>`** | **— missing —** |

A user who types `muse completion zish` (one-edit typo for
`zsh`) or `muse completion bsh` (one-edit for `bash`) pre-fix
got only:

```
muse completion: only 'bash' and 'zsh' are supported (got 'zish')
```

Three valid values listed but no actionable suggestion. The
sibling commands all carry the convention; closing this
outlier keeps the CLI typo-tolerance uniform.

## Slice

- `apps/cli/src/commands-completion.ts` — imported
  `closestCommandName` and added a `SUPPORTED_SHELLS:
  readonly SupportedShell[] = ["bash", "zsh"]` constant.
  The bad-shell branch now appends the standard
  `— did you mean '<closest>'?` tail when the typo is
  within edit distance.
- `apps/cli/test/program.test.ts` — extended the existing
  `muse completion bash + zsh` test with three additional
  cases: `zish` → suggests `zsh`; `bsh` → suggests `bash`;
  `totally-unrelated` gets the listing only with no
  false-positive suggestion. Same coverage shape as goal
  567's `--transport` test.

## Verify

- New assertions green within the existing
  `muse completion` test; full `@muse/cli` suite green
  (1027 passed, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the
  `closestCommandName` + ternary hint logic reverts the
  error message to the pre-fix bare form; the new
  `zish → zsh` assertion fails with `expected "muse
  completion: only 'bash' and 'zsh' are supported (got
  'zish')\n" to contain "did you mean 'zsh'?"`. Fix
  restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 249
  passed, apps/cli 1027 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- Pure CLI validation error — no LLM request-response
  wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9). The defended
  path is `muse completion` shell-argument validation,
  not the model loop.

## Status

Done. A fresh grep `grep -rnE "only '[a-z]+' and '[a-z]+'"
apps/cli/src/ | grep -v "did you mean"` returns zero hits
— every enum-style CLI validation that lists a closed
candidate set now carries the closest-command
suggestion.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
convention-parity polish on the existing `muse
completion` shell validation, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Same `closestCommandName + ternary hint` shape as
  every sibling convention site (567 in particular for
  closely matching pattern with a literal candidate set).
  Cross-command consistency wins.
- The candidate set `["bash", "zsh"]` is hoisted to a
  `SUPPORTED_SHELLS` `readonly` constant so the existing
  `normalized !== "bash" && normalized !== "zsh"` check
  and the closestCommandName call use the same source
  of truth visually. Same idiom goals 539/540/567 used.
- The hint suggestion is only appended when
  `closestCommandName` returns a real candidate (the
  ternary's `suggestion ? ... : ""` short-circuits).
  This prevents a misleading suggestion for unrelated
  input (`muse completion totally-unrelated` gets the
  listing only).
- Did NOT change the existing error message structure
  beyond the trailing hint. Pre-fix consumers that grep
  for "only 'bash' and 'zsh' are supported" continue to
  work; the new hint is purely additive after the
  closing parenthesis (matches goal 567's pattern).
- The mutation reverts to the pre-fix bare-message form.
  Smallest semantic delta; surgical proof.
- The test exercises THREE branches: one-edit typo on
  `zsh`, one-edit typo on `bash`, and unrelated input
  (no false-positive). Same coverage shape as the
  goal-567 `--transport typo` test.
- Step-8 sub-defect-class check: did-you-mean /
  closest-command convention parity was last shipped 7
  iterations ago (567 → `--transport`). Well past the
  ≥3-in-last-10 threshold; fresh defect-class slot.
