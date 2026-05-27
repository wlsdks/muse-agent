# 552 — `muse actions --json` emits machine-readable envelope (CLI list-command `--json` convention sibling sweep)

## Why

Step-8 redirect away from the run of comparator-determinism /
HOME-resolution / did-you-mean sibling sweeps (goals 533-551).
The next defect class to clean up is **CLI list-command
`--json`-mode asymmetry**: 39 of the CLI's 41 list-style
commands (`muse tasks list --json`, `muse remind list --json`,
`muse followup list --json`, `muse calendar list --json`,
`muse feeds list --json`, `muse notes search --json`, `muse
memory facts --json`, …) emit a 2-space-indented JSON envelope
for scripting. Two list-style commands are missing it:

```bash
muse actions          # the P6 accountability read surface
muse objectives list  # the P5-b1 standing-objectives surface
```

Without `--json`, anything scripted against `muse actions`
must parse a human-readable line format like
`2026-05-19T14:00:00.000Z  [performed]  objective met — user
notified (obj_ship) — newer`. That's brittle: a field gains a
separator, a future detail key gets added, the human format
changes — every consumer breaks. `muse actions` is *the*
audit surface for autonomous behaviour; the user (or a
wrapper script the user runs to feed the log into a
dashboard / weekly review / paste-into-incident-report) is the
exact reader who needs structured output.

This goal closes the first of the two (`muse actions`), with
the second (`muse objectives list`) explicitly deferred to a
sibling iteration.

## Slice

- `apps/cli/src/commands-actions.ts` — added `--json` option;
  on `--json`, emit
  ```json
  {
    "entries": [...serializeActionLogEntry(e)],
    "result": "performed|refused|failed|all",
    "total": N,
    "user": "local|all|..."
  }
  ```
  via `JSON.stringify(payload, null, 2)`. Empty log under
  `--json` returns `{ entries: [], total: 0, ... }` instead of
  the human-readable `"No recorded actions."` line — scripts
  parse JSON unconditionally. Imported the existing
  `serializeActionLogEntry` from `@muse/mcp` for the envelope
  shape (already used by the goal-405 daemon-side serializer).
- `apps/cli/src/commands-actions.test.ts` — added one
  `it("...")` covering: empty log under `--json`, populated
  log under `--json` (newest-first ids + objectiveId echoed),
  and `--json --limit 1 --result performed` (filters
  composing through to the envelope).

## Verify

- New `it(...)` green; full `@muse/cli` suite green (984
  passed, +1 vs baseline 983, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): deleting the
  `if (options.json)` branch makes the new test fail with the
  precise pre-fix symptom — `json mode must NOT emit the
  human-readable empty-state line: expected 'No recorded
  actions.\n' not to contain 'No recorded actions.'`. Fix
  restored, suite back to all green (984 passed).
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 984 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows only
  the three intended files.
- Pure CLI rendering — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is `muse actions`
  output, not the model loop.

## Status

Done. The CLI `--json` convention now covers `muse actions`
(P6 accountability log review). One outlier remains: `muse
objectives list` — the deferred sibling iteration whenever the
list-command `--json` defect class comes up again.

A future grep for CLI list-style commands without
`option("--json", …)` should narrow to a single remaining hit
(`commands-objectives.ts`); the convention is otherwise the
codebase standard.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a programmable-surface `feat:`
on the existing P6 accountability log review surface,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the recent run of sibling-asymmetry
  fixes (533-551 were all comparator-determinism / HOME /
  did-you-mean sweeps). This is a different defect class
  (output-format completeness) on a different surface
  (programmable JSON envelope vs. line-format parsing).
- Matched the envelope shape to `muse followup list --json` /
  `muse remind list --json` byte-for-byte: an `entries` array
  alongside the filter parameters and a `total` count. Cross-
  command convention is the codebase standard; the next
  sibling iteration on `muse objectives list` will use the
  same shape.
- Used the existing `serializeActionLogEntry` helper from
  `@muse/mcp` rather than passing raw `ActionLogEntry`
  objects: the helper already strips internal-only fields
  and conditionalises `objectiveId` / `detail`. Cross-package
  serializer reuse is the codebase convention (matches
  `serializeFollowup`, `serializeReminder`, `serializeTask`).
- Empty log under `--json` returns the empty envelope, NOT
  the human-readable `"No recorded actions."` line — JSON
  consumers must parse unconditionally; emitting prose to
  stdout under `--json` would break every scripted reader.
  Mirrors `muse followup list --json` semantics (empty
  followups → `{ followups: [], status: "scheduled", total:
  0 }`).
- Did NOT touch `muse objectives list --json` in this
  iteration: that's a fresh iteration target. One sibling
  per commit keeps the diff reviewable and the test fixture
  focused; one-iteration-per-area scope is the codebase
  convention (matches the goal 537 → 551 split on tiebreakers).
