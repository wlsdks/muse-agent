# 408 — P8 b3/b4 production-assembly seam audit

## Why

Step-4 target-completion audit. P8's original audit (README
Rejected ledger) explicitly covered only b1/b2 — "both P8
piece-checks re-run green together (8/8)" — the composer + the
real-channel delivery. The loop-extended bullets **b3** (goal 400,
real imminent *tasks* grounding) and **b4** (goal 401, real
imminent *calendar* grounding, unioned soonest-first) were added
**after** that audit, changing P8's completion state to four
`[x]` bullets that were never seam-audited as one whole.

A grep of the production path found a genuinely unguarded seam:
`startSituationalBriefingDaemonIfConfigured` (apps/api
`tick-daemons.ts`) builds the per-tick imminent source as
`deriveBriefingImminent(options.tasksFile)` ⊎
`deriveCalendarBriefingImminent(options.calendar.listEvents)` and
wires it into the tick. That construction had **no assertion**:

- goal 396's `situational-briefing-daemon.test.ts` tests only its
  env-gate / register / stop discipline (the tick never fires);
- the b3/b4 cases in `situational-briefing-tick.test.ts` hand-build
  the union themselves and inject it — they exercise the tick, not
  the production builder that derives the union from
  `ServerOptions`.

So a regression that dropped the calendar branch, passed the wrong
file, or mis-wired the union in the production daemon builder would
have kept the entire suite green — exactly the "marked done but
went sideways at the seam" the Step-4 audit exists to catch.

(Step-8 anti-concentration: this is a different axis from the
recent objectives/CLI cluster — a P8 anticipation-path
verification gap surfaced by the mandated target-completion audit,
not new surface.)

## Slice

- `apps/api/test/situational-briefing-daemon-imminent-seam.test.ts`
  — mocks only `../src/situational-briefing-tick.js` (via
  `vi.hoisted` + `vi.fn`) so the test captures exactly what the
  **real** `startSituationalBriefingDaemonIfConfigured` wires:
  - real `tasksFile` (an imminent open task) + a real duck-typed
    `ServerOptions.calendar.listEvents` (an imminent timed event) +
    real `objectivesFile` + env configured → assert the daemon
    registered its `onClose` stop hook AND the captured
    `imminentProvider`, invoked at a fixed `now`, returns the union
    of both the real task (`kind:"task"`) and the real calendar
    event (`kind:"calendar"`, correct `startsAt`), length 2;
  - neither `tasksFile` nor `calendar` set ⇒ the builder wires NO
    imminent source (objective-status-only briefing) — pins the
    `tasksFile || briefingCalendar` guard.

The production code mirrored under test is the actual builder
expression — not a re-implementation; b1/b2 stay covered by
`p8-seam.test.ts`, b3/b4 derivers by `briefing-imminent.test.ts`.
This closes the one seam none of them touched.

## Verify

- New test: `@muse/api` situational-briefing-daemon-imminent-seam
  2/2.
- P8 audit (re-run together): `@muse/mcp`
  situational-briefing.test.ts + situational-briefing-loop.test.ts
  + p8-seam.test.ts + briefing-imminent.test.ts = 13/13; `@muse/api`
  situational-briefing-tick.test.ts +
  situational-briefing-daemon.test.ts +
  situational-briefing-daemon-imminent-seam.test.ts = 11/11.
- `pnpm check` EXIT=0, every workspace green (agent-core 585,
  mcp 485, api 194, cli 701, …); tsc strict (apps/api) clean;
  `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean.
- Test-only, no `src` change, no request/response (LLM) path —
  composer/derivers are pure, delivery faked at the HTTP boundary;
  no `smoke:live` applies.

## Status

Done — the P8 audit (b3/b4) PASSED. The whole P8 chain composes
for the user end-to-end: the production daemon builder grounds the
briefing in the user's REAL imminent tasks + calendar (new seam) →
the composer synthesises soonest-first Upcoming + objective status
(p8-seam) → delivered intact over the real channel, deduped
(p8-seam). No drift, no bullet REOPEN — the production code was
correct, only unverified-as-assembled; it is now guarded.

No CAPABILITIES line and no OUTWARD-TARGETS flip: P8's bullets were
already `[x]`; this is the mandated audit itself plus closing the
verification gap it surfaced — a `test(api):` change recorded
honestly via the README Rejected-ledger `P8 audit (b3/b4)` line,
not a false metric. Same honesty discipline as the P0/P5/P6/P7/P9
seam audits.

## Decisions

- Mocked only the tick module (not the derivers/composer/stores)
  so the union under test is the genuine production builder running
  against real on-disk stores — a faithful seam, not a stub.
- Asserted the captured `imminentProvider`'s output rather than
  driving the `setInterval` tick: deterministic, no timer/clock
  flakiness, and it isolates exactly the previously-unguarded seam
  (ServerOptions → union construction) without re-testing
  already-covered compose/deliver/derive pieces — right-sized, no
  gold-plating.
