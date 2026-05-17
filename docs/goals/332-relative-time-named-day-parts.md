# 332 — "tomorrow morning" / "monday evening" failed the relative-time grammar

## Why

`parseTimeOfDay` recognised `noon`, `midnight`, `Nam`/`Npm`,
24h `HH:MM`, and (post-329) a bare hour — but not **named
day-parts**. "remind me tomorrow morning", "tomorrow evening",
"monday night", "today afternoon" all hit the final
`"invalid"` and aborted the whole phrase. Day-parts are one of
the most natural ways a person schedules something ("ping me
tomorrow morning"), and especially common via voice. Other
goals (329 bare hour, 330 article, 331 second unit) closed
adjacent gaps on this same core JARVIS input surface; this is
the remaining high-frequency one.

Verified-and-rejected several other candidates this iteration
before landing here — the guard pipeline correctly fails closed
on a thrown stage (guard-pipeline.ts:52-65), `StepBudgetTracker`
is fully finite-guarded, and `parseTaskDueAt`'s failure message
is already actionable with examples. The day-part gap is the
one concrete, user-facing, tight-scope win.

## Scope

`packages/mcp/src/loopback-relative-time.ts` — `parseTimeOfDay`:

- New `DAY_PART_HOURS` map (`morning 09`, `afternoon 15`,
  `evening 18`, `night 21`) consulted right after the
  `noon`/`midnight` literals and before the numeric patterns.
  `morning` deliberately equals the bare-day `DEFAULT_HOUR` (9)
  for consistency; the others are conventional defaults. One
  short WHY comment records that these hours are deliberate
  conventions (non-derivable).

Tightest possible change — one constant map + one lookup, in
the same literal-keyword position as `noon`/`midnight`. Flows
through the existing day-head + timeSpec machinery, so
"tomorrow morning", "today evening", "next monday evening", and
the explicit "tomorrow at morning" all work with no other
change. `noon`/`midnight` keep their dedicated branches; am/pm,
`HH:MM`, bare-hour, and Korean are untouched and still take
precedence where they match. Standalone "tonight"/"this
evening" (no day head) is a separate combined day+time shape and
is intentionally out of scope for this tight change.

## Verify

- `pnpm --filter @muse/mcp test` — 354 pass (was 353; +1). New
  test: "tomorrow morning" → next day 09:00, "tomorrow
  afternoon" → 15:00, "today evening" → 18:00, "tomorrow night"
  → 21:00, "next monday evening" → Monday 18:00, "tomorrow at
  morning" → 09:00, "tomorrow noon"/"tomorrow midnight" still
  12:00/00:00 (dedicated branches intact), "tomorrow lunchtime"
  → `undefined` (unknown word still unrecognized). The existing
  am/pm / HH:MM / bare-hour (329) / article (330) / second
  (331) / Korean / out-of-range suites stay green.
- `pnpm check` — every workspace green (mcp 354, apps/cli 563,
  apps/api 161, all packages). `pnpm lint` — exit 0. The
  goal-227 enforcement test (328) stays green.
- No real-LLM request/response path touched — deterministic
  input-phrase parsing; the resolved `Date` feeds the
  reminder/task stores, not a model round-trip. The
  deterministic regression is the rigorous verification.

## Status

done — the relative-time grammar now resolves named day-parts
("tomorrow morning" → 09:00, "monday evening" → 18:00),
closing the last high-frequency day-part phrasing gap; all
prior time forms and precedence are unchanged and unknown words
still fail safely to `undefined`.
