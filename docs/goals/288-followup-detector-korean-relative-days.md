# 288 — Korean "N일 후" follow-up promises were silently dropped

## Why

`extractFollowupPromises` (`@muse/agent-core`) scans the
assistant's turn for time-bound promises ("I'll get back to you
in …") so the proactive-notice daemon can actually schedule the
follow-up. The English side resolves
`in N (min|hour|day|days)` — **including days**. The Korean side
resolved only `N분` (minutes) and `N시간` (hours); there was **no
`N일` (days) pattern**.

For this Korean-primary project, "3일 후에 확인해서
알려드릴게요" ("I'll check and let you know in 3 days") is a
completely natural multi-day follow-up promise. With no `일`
pattern it matched nothing → no promise extracted → the daemon
never scheduled it → the agent **silently broke a promise it
made to the user**. A JARVIS that says it will follow up and then
never does is exactly the failure this detector exists to
prevent, and the gap was asymmetric with the already-supported
English `days`.

## Scope

`packages/agent-core/src/followup-detector.ts`:

- Add a `korean-relative-days` kind and a
  `(\d{1,3})\s*일\s*(?:뒤|후|이내(?:에)?)` matcher → `now + N
  days`, mirroring the existing `분` / `시간` loops (same
  zero/negative guard, same dedupe).
- The tail is **deliberately stricter** than `분`/`시간` (require
  `뒤` | `후` | `이내`, not the permissive bare `에`): `일` is
  ambiguous with a day-of-month — "30일에 회의" is "a meeting on
  the 30th", not "in 30 days". A one-line WHY comment records
  this (non-derivable rationale).
- Module doc's Korean supported-patterns list updated to include
  `N일 뒤 | N일 후 | N일 이내`.

Purely additive — every previously-matched English/Korean phrase
is unchanged; only Korean day-relative promises that were dropped
are now extracted, and only with an explicit relative marker.

## Verify

- `pnpm --filter @muse/agent-core test` — 536 pass. New
  regression: "3일 후에 …" → exactly one
  `korean-relative-days` promise at `now + 3d`; `2일 뒤` and
  `5일 이내에` also classify as `korean-relative-days` (the
  latter at `now + 5d`); a `30일에 회의` day-of-month produces
  **no** `korean-relative-days` promise. The existing
  `N분 뒤` / `N시간 후` / `내일 아침` / `오늘 H시에` /
  `시간`-not-`시+간` Korean tests stay green.
- `pnpm check` — every workspace green (agent-core 536,
  apps/cli 561, apps/api 160, all packages). `pnpm lint` —
  exit 0.
- No real-LLM request/response path touched
  (`extractFollowupPromises` is a pure deterministic scan over an
  already-produced assistant turn). A live Qwen run cannot emit a
  specific "N일 후" phrase on demand, so the deterministic
  regression is the rigorous verification — same stance as goals
  261 / 274–287 and the detector's own existing tests.

## Status

done — Korean multi-day follow-up promises ("N일 후/뒤/이내")
are now extracted and schedulable instead of silently dropped,
closing the asymmetry with the English `days` support, while a
bare `N일에` date-of-month is correctly excluded. All prior
patterns are unchanged.
