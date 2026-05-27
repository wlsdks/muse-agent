# 588 — `LocalCalendarProvider.updateEvent` clears optional fields on `""` / `[]` the same way `createEvent` strips them (create/update field-clear symmetry)

## Why

The local calendar provider had asymmetric optional-field handling
between `createEvent` and `updateEvent`:

- `createEvent` (line 78-80) uses a truthy check on each optional
  field — `...(input.location ? { location: input.location } : {})`
  — so an empty string `""` or empty array `[]` is STRIPPED from
  the persisted event entirely; the field is absent in the JSON
  store.

- `updateEvent` (line 103-111) routes through `applyOptionalString` /
  `applyOptionalArray` helpers. These accepted `null` as the
  explicit clear but treated `""` and `[]` as "store the empty
  value" — `next ?? existing` returned the empty string / empty
  array because neither is nullish. The resulting event then had
  `location: ""` / `tags: []` PRESENT in the merged record, where
  `createEvent` would have absented them.

Consequence: an event created with `location: ""` and an event
updated to `location: ""` had DIFFERENT persisted shapes. Scripts
that round-trip events through both paths saw the field absent
sometimes and present-as-empty other times — quiet inconsistency
that breaks `JSON.stringify` round-trip equality and confuses
diff-based observability.

Step-8 redirect: the prior 3-of-10 commits sat in the boolean-
spelling theme (autoconfigure / runtime-settings / model). This
iteration moves to `packages/calendar` and a distinct defect
class: create-vs-update normalization asymmetry on optional
fields. Clean break from the env-flag sweep.

## Slice

- `packages/calendar/src/local-provider.ts`:
  - `applyOptionalString` — add an empty-string branch that
    returns `undefined`, matching `createEvent`'s truthy-only
    strip. Whitespace-only (`"   "`) still passes through
    because `createEvent`'s truthy check accepts it (consistent
    with the existing — if slightly odd — convention).
  - `applyOptionalArray` — add an empty-array branch (length 0)
    that returns `undefined`, matching `createEvent`'s
    `tags.length > 0` strip.
- `packages/calendar/test/calendar.test.ts` — new nested
  `describe` block "updateEvent — create/update field-clear
  symmetry" with 6 tests covering:
  - `null` clears location (the original documented clear path —
    previously untested directly),
  - `""` clears location AND mirrors create-time strip,
  - `""` clears notes (sibling defect),
  - `[]` clears tags AND mirrors create-time strip,
  - omitted fields preserve existing values (regression guard
    on the helper's primary purpose),
  - whitespace-only `"   "` passes through unchanged on both
    create and update (symmetric — pinned so a future tightening
    that strips whitespace doesn't desymmetrise the surface).

## Verify

- `@muse/calendar` suite green (44 passed, +6 vs baseline 38, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting both helpers
  to the pre-fix shape (`next ?? existing` without the empty-
  string / empty-array guard) makes 3 of the 6 new tests fail —
  the "" clears location, "" clears notes, and [] clears tags
  cases. The null-clear, omit-preserves, and whitespace-passes
  cases are unaffected (those code paths didn't change). Solid
  3-of-6 mutation proof. Fix restored, suite back to all green.
- `pnpm check` EXIT=0 (apps/api 249 passed, apps/cli 1040 passed,
  every workspace green); `pnpm lint` 0/0; `pnpm guard:core`
  clean; `git status` shows only the two intended files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is local-filesystem JSON persistence under
  `LocalCalendarProvider`, not the model loop.

## Status

Done. The local calendar provider now has symmetric create/update
field-clear semantics:

| Input shape            | Before (create)    | Before (update)             | After (update — matches create) |
| ---------------------- | ------------------ | --------------------------- | ------------------------------- |
| `location: undefined`  | absent             | preserves existing          | preserves existing (unchanged)  |
| `location: null`       | n/a (not in input) | clears                      | clears (unchanged)              |
| `location: ""`         | absent (stripped)  | **stores `""`** (asymmetric) | absent (**fixed**)              |
| `location: "Room A"`   | stores             | stores                      | stores (unchanged)              |
| `location: "   "`      | stores (whitespace) | stores                     | stores (unchanged — symmetric)  |
| `tags: undefined`      | absent             | preserves existing          | preserves existing (unchanged)  |
| `tags: null`           | n/a                | clears                      | clears (unchanged)              |
| `tags: []`             | absent (stripped)  | **stores `[]`** (asymmetric) | absent (**fixed**)             |
| `tags: ["a", "b"]`     | stores             | stores                      | stores (unchanged)              |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
consistency `fix:` on the local calendar persistence surface,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **Empty string strip, not whitespace strip.** `createEvent`
  uses a plain truthy check (`input.location ? ...`), which
  considers `"   "` truthy and stores it. The update fix
  mirrors that exactly: `next === ""` clears, but `"   "`
  passes through. Considered also stripping whitespace-only
  strings (more aggressive) — rejected as a separate convention
  change. If/when `createEvent` adopts trim-and-strip, the
  update helper should match in the same iteration. For now,
  symmetry is the goal, not stricter normalization.
- **Empty-array clear via `length === 0`.** `createEvent` uses
  `input.tags && input.tags.length > 0`, which strips both
  `undefined` and `[]`. The update helper splits the cases
  explicitly: `next === null` (explicit clear), `next.length ===
  0` (sibling clear), `next === undefined` (preserve). Same
  end-state shape as create, with the in-between explicit-null
  path preserved.
- **Why test `null` and `omit` paths despite no behavior
  change.** The original `applyOptionalString` had no direct
  tests — only the updates-with-explicit-values path was
  covered. Adding the null-clear and omit-preserve tests
  alongside the new empty-string-clear test brings the helper
  to fully-pinned coverage, so a future refactor cannot
  silently regress the documented null-as-clear or omit-as-
  preserve semantics.
- **Why test the sibling create-time strip in the same tests.**
  The mutation guard is tightest when both ends of the symmetry
  are asserted in the same test body. A future change to
  `createEvent`'s truthy check (e.g. someone removing the
  strip) would break the "fresh.location is undefined" assertion
  next to the update-side test, surfacing the regression with
  the matching half of the contract still visible.

## Remaining risks

- The Kysely-backed calendar providers (`CalDAVCalendarProvider`,
  `GoogleCalendarProvider`, `MacOsCalendarProvider`) own their
  own update paths and may have parallel asymmetries on a
  provider-specific PATCH wire format. Out of scope for this
  iteration — they go to remote services with different
  empty-field semantics (CalDAV: `<DELETE/>` patches, Google:
  null vs empty distinction). Worth a follow-up audit, not a
  byte-for-byte port of this fix.
- `LocalCalendarProvider.listEvents` sorts by `startsAt` with
  an `id` asc tiebreaker (added in goal 574); the registry's
  `listEventsWithDiagnostics` fan-out sort has only the
  startsAt key — non-deterministic tie order across providers.
  Separate defect (multi-provider sort), separate iteration.
