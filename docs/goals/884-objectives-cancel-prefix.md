# Goal 884 — `muse objectives cancel` accepts an unambiguous id prefix

## Outward change

`muse objectives cancel <id>` now resolves an exact id OR an
unambiguous **prefix** of `obj_<uuid>`, so cancelling a standing
objective no longer requires pasting the full 40-char id. `muse
objectives cancel obj_a1b2c3d4` works when that prefix is unique.
An ambiguous prefix (matches >1) is refused with a clear message and
cancels nothing; an unknown id still errors with a closest-match
hint. This matches the prefix-resolution every other id-addressed
surface already offers (`muse followup`, `muse calendar
delete/edit/show`, `muse notes delete`).

## Why this, now

Objectives is the user's delegated-autonomy surface (P5 store / P9
daemon) — `add` / `list` / `cancel`. It was the lone id-addressed
command that demanded the *whole* `obj_<uuid>`, while every sibling
resource accepts a short prefix. Pasting a full UUID to stop an
autonomous objective is real daily friction and a genuine
consistency gap — the smallest verifiable UX correctness fix on a
fresh, not-recently-touched surface.

## How

Added `resolveObjectiveId(input, all)` →
`match | ambiguous | none`: exact id wins; otherwise a single
`startsWith` prefix match resolves; an empty input or >1 match never
silently picks one. `cancel` resolves first, then patches the full
id (reporting the resolved id in `Cancelled <full-id>`). The
unknown-id / closest-hint path is preserved.

## Verification

`apps/cli` `commands-objectives.test.ts`: a new test cancels by a
12-char prefix and asserts the FULL id is reported + the store
reflects the cancel; another adds two objectives, cancels by `obj_`
(matches both), and asserts an `ambiguous … matches 2` error with
both still active. The existing exact-id, missing-id, and
near-miss-typo cases stay green (a same-length last-char typo is not
a prefix → still the closest-hint path). Mutation-proven: disabling
the prefix branch fails both new tests. No LLM path → no smoke:live;
Ollama down regardless. `pnpm check` exit 0, `pnpm lint` 0/0.

## Decisions

- Local resolver mirroring `muse followup`'s `resolveFollowupId`
  rather than extracting a shared helper — only one call site here;
  a premature shared abstraction across three slightly-different
  resolvers isn't warranted.
- Guard empty input → `none`: with prefix matching, an empty string
  `startsWith`-matches everything, which must never silently cancel
  an objective.
