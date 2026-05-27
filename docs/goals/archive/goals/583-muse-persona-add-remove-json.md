# 583 — `muse persona add --json` + `muse persona remove --json` emit structured envelopes (goal-582 deferred siblings)

## Why

Direct goal-582 follow-up. Goal 582 shipped `--json` on
`muse persona use` and explicitly deferred the matching
flags on `add` and `remove` with the rationale "envelope
shapes differ enough to warrant separate decisions per
iteration". This iteration closes both, completing the
persona write-surface `--json` sweep.

Pre-fix:
- `muse persona add tony "..."` emitted
  `Added custom persona tony` (or `Updated...` on
  re-add) — scripts had to grep for the verb to
  distinguish create-vs-update.
- `muse persona remove tony` emitted
  `Removed custom persona tony` with an optional
  `(active persona reset to default)` tail — scripts
  had to substring-match the parenthetical.

Both cases hide the structured information scripts care
about: did this CREATE or UPDATE? did this RESET the
active persona? An envelope makes both queryable.

## Slice

- `apps/cli/src/commands-persona.ts` — added `--json`
  option to both `add` and `remove`. Envelopes:
  - `add`: `{ action, id }` where `action: "added"`
    on first registration, `"updated"` when the same
    id was already present.
  - `remove`: `{ id, resetActive, activeId }` where
    `resetActive: true` means the removed persona was
    active and the store's `activeId` was reset to
    `"default"`. `activeId` echoes the post-remove
    state.
  Both envelopes preserve the legacy human-readable
  output when `--json` is omitted (backwards-compatible).
- `apps/cli/test/program.test.ts` — added one
  `it(...)` immediately before the existing `muse
  persona add` test: exercises first-add → action:
  "added"; second-add → action: "updated"; remove
  inactive → resetActive: false; remove active →
  resetActive: true with activeId reset to "default".

## Verify

- New `it(...)` green; full `@muse/cli` suite green
  (1034 passed, +1 vs baseline 1033, 0 failed); tsc
  strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): collapsing
  the `add`'s `--json` branch back to the pre-fix
  `io.stdout(legacy)` shape makes the test fail with
  `expected "Added custom persona tony\n" to NOT
  contain "Added"` — the JSON-expected output gets
  the legacy human-readable line instead. Fix
  restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api
  249 passed, apps/cli 1034 passed); `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean;
  `git status` shows only the three intended files.
- Pure CLI write surfaces — no LLM request-response
  wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9). The defended
  path is `muse persona add --json` and `muse persona
  remove --json` scripted use, not the model loop.

## Status

Done. The persona write-surface `--json` sweep is
complete:

| Command | --json envelope |
| --- | --- |
| `muse persona use` | `{ activeId, previousActiveId }` (582) |
| `muse persona add` | `{ action, id }` (this goal) |
| `muse persona remove` | `{ id, resetActive, activeId }` (this goal) |

A future grep for persona write commands without `--json`
support should return zero hits. The persona surface is
now fully scriptable end-to-end.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
direct goal-582 sibling closing the deferred write-side
envelope work, recorded honestly with this backlog row —
not a false metric.

## Decisions

- `add` envelope key `action: "added" | "updated"` (not
  just `replacing: true | false`). Reason: the verb is
  more descriptive and grep-friendly. A future
  third-state ("noop" if the preamble is unchanged) could
  fit naturally; `replacing: boolean` doesn't extend.
- `remove` envelope includes `activeId` (post-remove).
  Reason: scripts that need to chain `remove` → `use
  <something>` benefit from knowing the current active
  state directly, not via a follow-up `muse persona
  show --json`. The triple `(id, resetActive,
  activeId)` is the minimal complete description.
- The action's signature gained a third positional
  parameter (`options`) on `add`. Reason: commander
  passes positional args before options; the variadic
  `[preamble...]` precedes the `--json` option. The
  signature `(id, preambleParts, options)` is the
  natural commander-friendly shape and matches the
  goal-573 stdin-fallback signature byte-for-byte.
- The mutation reverts the `add` --json branch (one of
  two identical patterns). The `remove` branch has the
  same shape and would mutate-fail identically; cross-
  command convention to test one representative of a
  symmetric pair (matches goals 537/542/548).
- The test asserts FOUR scenarios (add-new,
  add-existing, remove-inactive, remove-active) so the
  four envelope shapes are all pinned. Same coverage
  shape as the goal-558 `remove` test.
- Step-8 sub-defect-class check: this is the
  deferred-sibling closure of goal 582, same as the
  goal 558 → 557 / 571 → 570 / 579 → 578 pattern.
  Cross-codebase convention to close deferred siblings
  in the next iteration.
