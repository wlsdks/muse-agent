# 484 — `muse routine` keeps `total / days = avg` arithmetically consistent when activity.jsonl carries malformed rows

## Why

Distinct defect class from the recent 478/481/482/483 empty-env
slice (Step-8 redirect: 4 in a row required a different area).
`computeRoutine` (`apps/cli/src/commands-routine.ts`) aggregates
`~/.muse/activity.jsonl` into the user-visible JARVIS-rhythm
summary that `muse routine` prints and that `chat-repl.ts` reads
internally. Output shape:

```
sessions: <totalSessions> across <daysObserved> days (avg <sessionsPerDay>/day)
```

`totalSessions` returned `rows.length` — the **raw** ingest
count, INCLUDING rows whose `tsIso` failed `Number.isFinite`
(the malformed/interrupted-write rows the inner loop skips on
line 80). `daysObserved` returned `days.size` — only the
**valid** days. `sessionsPerDay` divided `rows.length / days.size`.

So with even one malformed line in the activity log:

- `totalSessions=5 across daysObserved=2` shown to the user.
- `sessionsPerDay = 5 / 2 = 2.5` displayed.
- But the displayed `5` was inflated by malformed rows that
  produced no day entry — the relationship the line implies
  (`5 / 2 = 2.5`) is arithmetically wrong: the actual valid
  sessions were 2, not 5; the average across valid days is 1,
  not 2.5.

Real and reachable: a power-cut mid-write or any partial flush
of `activity.jsonl` produces an unparseable line — the
documented "skip malformed" path on line 67 of `readActivity`
already handles parsing, but a row that parsed JSON yet carries
a bad `tsIso` slips through to `computeRoutine`. The defect is
the divergence between numerator and denominator scopes.

`computeRoutine` had **zero direct test coverage**, so the
contract was implicit-only; nothing pinned the math.

## Slice

- `apps/cli/src/commands-routine.ts` — `computeRoutine` now
  counts `validSessions` (incremented inside the
  `Number.isFinite` guard) and returns
  `totalSessions: validSessions` /
  `sessionsPerDay: validSessions / days.size`. Behaviour
  byte-identical on a clean log (every row valid → validSessions
  === rows.length); only the malformed-row inflation is closed.
- `apps/cli/src/commands-routine.test.ts` — first direct
  coverage of `computeRoutine`: empty log → zeros; valid rows
  aggregate correctly; **malformed rows skipped from EVERY
  counter so `total / days = avg` holds**; unique-day counting
  (multi-hours-same-day → one day).

## Verify

- New test 4/4 green; full `@muse/cli` suite green (784 passed,
  0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to
  `totalSessions: rows.length` / `rows.length / days.size`
  makes the malformed-rows test fail with the precise pre-fix
  symptom (`expected 5 to be 2` — `totalSessions` returns the
  raw ingest count instead of the valid-session count) while
  the other 3 tests stay green; fix restored, suite back to 4
  green.
- `pnpm check` EXIT=0, every workspace green — no regression
  (chat-repl.ts consumes the summary internally for behavioural
  hints; behaviour byte-identical on a clean log);
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure deterministic analysis — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. The user-visible JARVIS-rhythm summary
`sessions: X across Y days (avg Z/day)` is now arithmetically
self-consistent regardless of stray malformed activity rows.
Clean logs are unaffected. First direct `computeRoutine`
coverage.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a correctness `fix:` on a JARVIS-UX
display surface, recorded honestly with this backlog row — not
a false metric.

## Decisions

- Step-8 redirect from the empty-env-shadow class (478/481/482/
  483 — four in five iterations). `commands-routine` is in
  apps/cli but the defect class is *counter-divisor scope
  mismatch*, not env shadowing — distinct correctness contract.
- Changed `totalSessions` to the valid count rather than
  introducing a new `validSessions` field beside `rows.length`:
  the display line `total / days = avg` is what a user reads;
  keeping `totalSessions` as the raw count would leave the
  arithmetic visibly wrong. The two existing consumers
  (`commands-routine.ts` print + `chat-repl.ts` import) both
  display / interpret it as the count that backs the per-day
  average — they want the consistent number, not the raw
  ingest count.
- First direct coverage of `commands-routine` — the module had
  no `.test.ts` and no other test referenced `computeRoutine`,
  so the contract was implicit-only; pinning it now keeps the
  fix from regressing on a future refactor.
