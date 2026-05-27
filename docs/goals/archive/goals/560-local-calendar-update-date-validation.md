# 560 — `LocalCalendarProvider.updateEvent` validates Date inputs (sibling-asymmetry parity with `createEvent`)

## Why

Step-8 redirect onto a fresh package — `packages/calendar` —
with a different defect class from the recent polish-cluster
(comparator-determinism, trim-symmetry, CLI add/remove). The
defect is a validation-parity gap between two paths of the
same provider:

```ts
// createEvent — calls validateEventInput which catches
// invalid Dates with a typed CalendarValidationError.
async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
  validateEventInput(input);                 //  ✅ Date validation
  ...
}

// updateEvent — bare merge, NO equivalent Date validation.
async updateEvent(id: string, input: CalendarEventUpdate) {
  ...
  const merged: CalendarEvent = {
    endsAt: input.endsAt ?? existing.endsAt, //  ⚠ accepts Invalid Date
    startsAt: input.startsAt ?? existing.startsAt,
    ...
  };
  if (merged.endsAt.getTime() < merged.startsAt.getTime()) { ... }
  //  ↑ NaN < <number> is always false, so the range check passes
  //    silently when either Date is invalid.
}
```

Concrete real-world impact: a caller mistypes a date string
and gets `new Date("not-a-date")` — an actual Date instance
whose `.getTime()` returns NaN. `updateEvent` accepts it,
silently saves the merged event, then `writeAll` calls
`event.endsAt.toISOString()` which throws
`RangeError: Invalid time value`. The caller sees a generic
RangeError, not a typed `CalendarValidationError("INVALID_END",
...)`. Worse, in the path where the error fires AFTER mutation
of the in-memory array but BEFORE `writeAll` rebuilds the
persistent file, the previous-write/next-read symmetry
holds — but the call signature looks like a 50/50 hit on
which error class wraps. The right behaviour is to reject at
the validate gate with the right error class, matching
`createEvent`.

This is the kind of consistency gap goal 538 (feeds-refresh
trim symmetry within one helper) and goal 559
(validate-outbound text vs destination trim symmetry within
one function) closed on other surfaces. Sibling-asymmetry
between TWO paths in the same provider is the same defect
class, different shape.

## Slice

- `packages/calendar/src/local-provider.ts` — inserted two
  Date-validity checks immediately before the existing
  range/title checks in `updateEvent`:
  ```ts
  if (!(merged.startsAt instanceof Date) || Number.isNaN(merged.startsAt.getTime())) {
    throw new CalendarValidationError("INVALID_START", "startsAt must be a valid Date");
  }
  if (!(merged.endsAt instanceof Date) || Number.isNaN(merged.endsAt.getTime())) {
    throw new CalendarValidationError("INVALID_END", "endsAt must be a valid Date");
  }
  ```
  Identical shape to the corresponding `validateEventInput`
  branches at lines 205-211. The order matters: validate
  Date-instance + finite-time FIRST, then the range check
  (the range check assumes both are finite numbers; without
  the prior validation, `NaN < N` silently passes).
- `packages/calendar/test/calendar.test.ts` — added one
  `it(...)` covering: invalid `input.endsAt`, invalid
  `input.startsAt`, and a sanity assertion pinning the
  create-time parity (same invalid Date through
  `createEvent` already rejects identically).

## Verify

- New `it(...)` green; full `@muse/calendar` suite green
  (37 passed, +1 vs baseline 36, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): deleting the two
  new validation blocks makes the test fail with the exact
  pre-fix symptom — `expected RangeError: Invalid time value
  to be an instance of CalendarValidationError`. That is
  the precise downstream `toISOString()` crash the pre-fix
  path produces. Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1000 passed, packages/calendar 37
  passed); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the three
  intended files.
- Pure local-file provider validator — no LLM request-
  response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9). The defended path
  is `LocalCalendarProvider.updateEvent` callers (the
  agent calendar tool + the `/api/calendar/events PATCH`
  HTTP surface), not the model loop.

## Status

Done. `LocalCalendarProvider`'s create/update validation
parity is restored:

- `createEvent` — `validateEventInput` checks title trim +
  Date validity + range
- `updateEvent` — merged Date validity + range + title
  trim (this goal)

A future hardening could lift the four Date-validity
branches (two for create, two for update) into a shared
helper `assertValidEventDates(startsAt, endsAt)`. Not in
scope for this iteration; cross-method helper consolidation
is a separate refactor in its own right.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry
validation-parity `fix:` on the calendar local provider,
recorded honestly with this backlog row — not a false
metric.

## Decisions

- Validate `merged.startsAt` / `merged.endsAt` AFTER the
  merge (not the raw `input.startsAt` / `input.endsAt`).
  Reason: the `??` merge folds in `existing.startsAt`
  when input is undefined. If `existing.startsAt` is
  somehow invalid (defense-in-depth against a corrupt
  persisted file), the merge path catches it too. The
  `isPersistedEvent` filter at `readAll` should already
  reject corrupt entries; this is the second-layer guard.
- Validation order: type-check + finite-check FIRST, then
  range check, then title trim check. The range check
  uses `.getTime()` arithmetic which silently mishandles
  NaN; the type/finite gate must come first or the range
  check becomes load-bearing for something it can't
  reliably detect. Matches the order in
  `validateEventInput` for symmetry.
- Did NOT extract a shared helper. Reason: one-iteration-
  per-area scope; the consolidation is a separate refactor
  with a wider blast radius. The four copies are now
  visually identical (two in `updateEvent`, two in
  `validateEventInput`), so a future iteration can do the
  consolidation with no behaviour change. The iteration-
  loop contract bans pure refactor sweeps as deliverables.
- Mutation reverts both new blocks (the two are a single
  semantic addition — Date validation). Smallest semantic
  delta as one revert.
- The new test asserts via `.toBeInstanceOf
  (CalendarValidationError)` rather than message matching.
  Reason: the typed error CLASS is the contract the
  caller wants (catch + recover); the message string can
  drift. Matches the existing "rejects events whose endsAt
  precedes startsAt" assertion shape one block above.
- Did NOT test that the file content is not mutated on
  rejection (i.e., that `writeAll` was never called). The
  validation throws BEFORE the writeAll call, so this is
  structurally enforced by control flow. Adding the
  assertion would test the test infrastructure, not the
  fix.
