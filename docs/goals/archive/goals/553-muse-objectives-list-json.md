# 553 — `muse objectives list --json` emits machine-readable envelope (goal-552 sibling closing the last CLI list-command `--json` outlier)

## Why

Direct sibling of goal 552 (`muse actions --json`). The CLI's
list-command `--json` convention now covered 40 of 41 surfaces;
`muse objectives list` was the last outlier — explicitly
deferred in goal 552's Decisions block.

`muse objectives` is the user entry point to the P5→P9
delegated-autonomy chain. Without `--json`, anything scripted
that reads "what standing objectives is Muse currently
pursuing" must parse the line format
`obj_<uuid>  [active/until]  watch the deploy until green`.
Brittle to detail-key additions. The standing-objective store
ALREADY exports `serializeObjective` (used by the daemon's
P9-b1 evaluator); the CLI just hadn't reached for it.

Closing this completes the CLI `--json` convention sweep
across every list-style surface in the codebase.

## Slice

- `apps/cli/src/commands-objectives.ts` — added `--json` option;
  on `--json`, emit
  ```json
  {
    "objectives": [...serializeObjective(o)],
    "status": "active|done|escalated|cancelled|all",
    "total": N,
    "user": "local|stark|..."
  }
  ```
  via `JSON.stringify(payload, null, 2)`. Empty store under
  `--json` returns the empty envelope, NOT the human-readable
  `"No objectives."` line — matches goal 552's `muse actions
  --json` semantics. Imported the existing `serializeObjective`
  from `@muse/mcp`.
- `apps/cli/src/commands-objectives.test.ts` — added one
  `it("...")` covering: empty store under `--json`, populated
  store under `--json` (id + kind + spec + status echoed), and
  `--status all --json` after a cancel (composing filter
  through the envelope: active=0, all=1 cancelled).

## Verify

- New `it(...)` green; full `@muse/cli` suite green (986
  passed, +2 vs baseline 984, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): deleting the
  `if (options.json)` branch makes the new test fail with the
  precise pre-fix symptom — `json mode must NOT emit the
  human-readable empty-state line: expected 'No objectives.\n'
  not to contain 'No objectives.'`. Fix restored, suite back
  to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 986 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows only
  the three intended files.
- Pure CLI rendering — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is `muse
  objectives list` output, not the model loop.

## Status

Done. The CLI list-command `--json` convention now reads
identically across **every** list-style surface I can find in
the codebase. A future grep for a CLI list command lacking
`option("--json", …)` should return zero hits in the
`commands-*.ts` family.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
programmable-surface `feat:` on the existing P5-b1 standing-
objectives CLI surface, recorded honestly with this backlog
row — not a false metric.

## Decisions

- Direct goal-552 sibling sweep, closing the deferred
  outlier the prior iteration explicitly named in its
  Decisions block. One-iteration-per-area scope kept goal
  552 reviewable; this iteration finishes the convention
  pair the way that note promised.
- Matched the envelope shape to goal 552 byte-for-byte:
  `entries`/`objectives` is the list, alongside the filter
  parameters and a `total` count. Cross-command convention
  is the codebase standard.
- Used the existing `serializeObjective` from `@muse/mcp`
  rather than passing raw `StandingObjective` objects: the
  helper conditionalises `lastEvaluatedAt` / `attempts` /
  `nextEvalAt` / `resolution`. Cross-package serializer
  reuse is the codebase convention (matches goal 552's use
  of `serializeActionLogEntry`).
- Empty store under `--json` returns the empty envelope,
  NOT the human-readable `"No objectives."` line. JSON
  consumers must parse unconditionally; emitting prose to
  stdout under `--json` would break every scripted reader.
  Mirrors goal 552's `muse actions --json` semantics.
- The test composes `--status all --json` post-cancel to
  prove the filter parameter rides through into the
  envelope correctly (status="all" echoed; cancelled
  objective surfaces in the array). Higher-leverage than
  a separate single-filter assertion.
