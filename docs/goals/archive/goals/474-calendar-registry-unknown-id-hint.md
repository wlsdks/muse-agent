# 474 — calendar registry unknown-id error names the registered providers (goal-472/473 sibling slice)

## Why

Continuation of the goal-472/473 actionable-error rollout
explicitly logged in the Rejected ledger. `@muse/voice` (472) and
`@muse/messaging` (473) were discharged; the calendar and MCP
tasks/notes registries still threw the hint-less
`Calendar provider not registered: <id>`.

`CalendarProviderRegistry.require(providerId)` is the resolution
point on the **ambient-awareness** path: the situational-briefing
daemon's calendar-imminent provider (`deriveCalendarBriefingImminent`
in P8-b4) and the apps/api `/api/calendar/*` routes both
funnel through `registry.require()`. A typo'd / unconfigured
`MUSE_*_CALENDAR_*` id surfaced a dead-end message to whoever is
debugging a silent briefing daemon or a 4xx from the calendar
API, with **no indication of what providers were actually
registered**.

The existing `CalendarProviderRegistry` registry test only
asserted `toThrowError(CalendarProviderError)` (not the message
text), so the enriched message introduces **no wrong premise**;
the recoverability of this error was untested.

## Slice

- `packages/calendar/src/registry.ts` — `require()` appends
  `registeredHint([...this.providers.keys()])`:
  ` (registered: a, b)` / ` (none registered)` — **byte-identical
  wording to goals 472/473** (single cross-package convention,
  not a re-derivation). The `CalendarProviderError` **code is
  unchanged** (`PROVIDER_NOT_FOUND`), so code-branching callers,
  the apps/api 4xx mapping, and existing assertions are
  unaffected.
- `packages/calendar/test/calendar.test.ts` — extended the
  existing `CalendarProviderRegistry` describe (prior tests
  untouched): empty registry → `/none registered/`; populated
  with the `local` provider → a typo'd id (`locale`) →
  `/registered: local/`.

## Verify

- New test green; pre-existing registry tests still green (no
  wrong premise — they assert error type, not message text);
  full `@muse/calendar` suite green (36, +1, 0 failed); tsc
  strict (calendar) EXIT=0.
- **Clean-mutation-proven** (Edit-based): neutralising
  `registeredHint` to `""` makes the new test fail with the
  precise pre-fix symptom (`expected [Function] to throw error
  matching /none registered/ but got 'Calendar provider not
  registered: local'`) while the pre-existing registry tests
  stay green; fix restored, suite back to green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure registry logic — no LLM / model request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A misconfigured calendar `providerId` (briefing daemon, API
route, or CLI) now yields
`Calendar provider not registered: x (registered: local)` — the
operator immediately sees the valid ids and whether the provider
was simply not wired. Three of the four goal-472-identified
sibling registries (`voice` / `messaging` / `calendar`) are
discharged; **`@muse/mcp` tasks/notes-providers remain**
(ledger line updated). Error codes and all success paths
unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an error-UX `fix:` continuing the
goal-472 actionable-error slice, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Picked calendar before MCP tasks/notes: calendar is in a
  different package than the immediately-prior iteration
  (messaging, 473), spreading the work across packages and
  avoiding the Step-8 same-area-churn risk that two consecutive
  MCP iterations would carry.
- Reused goals 472/473's exact `registeredHint` wording/shape
  rather than a variant: the actionable-error message must read
  identically across registries; a near-variant is the drift
  the single-pattern rollout exists to prevent.
- Updated (not re-appended) the goal-472 Rejected-ledger line to
  strike `calendar` — keeps the ledger accurate without bloating
  it; the remaining MCP tasks/notes work is preserved for the
  next iteration.
