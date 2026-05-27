# 582 — `muse persona use --json` emits a structured envelope so scripts can audit the transition

## Why

CLI scripting completeness on the persona write surface. Every
other write command in the codebase (`muse remind add`,
`muse tasks add/done`, `muse followup mark/resolve`,
`muse messaging send`) honors `--json` for machine-readable
output. `muse persona use` was the outlier — its only output
was the arrow form:

```
active persona → jarvis
```

Scripts that wanted to confirm "did the activation succeed
and what was the previous state?" had to:
1. Grep stdout for the arrow.
2. Lose access to the previous active id (the arrow line only
   echoes the new id).

Adding `--json` mirrors the persona read surface conventions
goals 552 / 553 / 565 / 566 established and exposes the
prior active id so scripts can audit the transition (useful
for "switch to persona X for this run, restore the previous
on exit").

## Slice

- `apps/cli/src/commands-persona.ts` — added `--json`
  option to `muse persona use`. The action captures
  `previousActiveId = store.activeId` BEFORE the
  `writePersonaStore` call, so the envelope can echo the
  prior state alongside the new active id. The legacy
  arrow output is preserved when `--json` is omitted
  (backwards-compatible).
- `apps/cli/test/program.test.ts` — added one `it(...)`
  immediately after the goal-100 typo-suggestion test:
  asserts `--json` emits `{ activeId, previousActiveId }`
  with no arrow leak, the store persists the new active
  id, and a no-`--json` follow-up keeps the legacy arrow
  output unchanged.

## Verify

- New `it(...)` green; full `@muse/cli` suite green (1033
  passed, +1 vs baseline 1032, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): collapsing the
  `--json` branch back to the bare `writePersonaStore +
  io.stdout(arrow)` shape makes the test fail with
  `expected "active persona → jarvis\n" to NOT contain
  "→"` — the arrow leaks where the JSON envelope was
  expected. Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api
  249 passed, apps/cli 1033 passed); `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the three intended files.
- Pure CLI write surface — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is `muse
  persona use --json` for scripted callers, not the
  model loop.

## Status

Done. The persona write-path now exposes machine-readable
output:

| Command | --json envelope |
| --- | --- |
| `muse persona use` | `{ activeId, previousActiveId }` (this goal) |
| `muse persona add` | — still plain text |
| `muse persona remove` | — still plain text |

A natural follow-up: `add` and `remove` are write surfaces
that could also benefit from `--json` envelopes
(`{ id, action: "added\|updated" }` /
`{ id, resetActive }`). Deferred to keep scope tight.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
CLI ergonomics improvement on an existing persona write
surface, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Envelope shape: `{ activeId, previousActiveId }`.
  Reason: the new active id is the obvious primary; the
  previous id is the asymmetric value scripts need for
  "restore on exit" / audit-log / undo flows. Same shape
  goal 577's `previewingId` adopted (additive contextual
  field).
- The legacy arrow output is preserved on the no-`--json`
  path. Reason: backwards-compatibility — interactive
  users see the same human-readable confirmation; only
  the explicit `--json` flag switches to envelope mode.
- `previousActiveId` is captured BEFORE the writePersonaStore
  call. Reason: the `store` variable is the in-memory
  snapshot pre-write; reading `store.activeId` after the
  write would still work since the mutation is on a
  separate spread, but capturing into a local first keeps
  the read-then-write order explicit and matches goal
  558's `wasActive = store.activeId === trimmed` shape
  byte-for-byte.
- The mutation reverts to the bare `writePersonaStore +
  io.stdout(arrow)` shape — both the `previousActiveId`
  capture and the if-options.json branch are the load-
  bearing delta. The mutation removes both at once,
  proving they're the additions under test.
- Did NOT add `--json` to `add` / `remove` in this
  iteration. Reason: one-iteration-per-area scope; the
  envelope shapes differ between the three commands
  (use → {activeId, previousActiveId}, add → {id,
  action}, remove → {id, resetActive}), so doing them
  together would be 3 separate write-time decisions in
  one commit. Defer to follow-ups.
- Step-8 sub-defect-class check: CLI write-surface
  `--json` envelope completeness is distinct from the
  recent security UX (581 transition warning),
  case-insensitivity (580), comparator-determinism
  (578/579), persona preview (577). The convention
  was last touched in 566 (envelope `total` on read
  surfaces) — that was the read sweep; this is the
  write sweep starting. Fresh sub-class slot.
