# 473 — messaging registry unknown-id error names the registered providers (goal-472 sibling slice)

## Why

Goal 472 fixed the hint-less dead-end
`… provider not registered: <id>` for `@muse/voice` and recorded
a README Rejected-ledger line: the identical pattern survived in
`@muse/calendar`, `@muse/mcp` tasks/notes, and **`@muse/messaging`**
registries. This iteration advances that explicitly-recorded
next slice (Step-3 continuity — deferral before any new goal),
one package per iteration to stay tight-scope.

The messaging registry is the highest-leverage of the four:
`MessagingProviderRegistry.require(providerId)` is the resolution
chokepoint for the **autonomous actuator path** — the proactive,
reminder, objectives, and situational-briefing daemons plus the
inbound responder all send through it (and `send()` calls
`require()` internally). A typo'd or unconfigured
`MUSE_*_PROVIDER` id therefore surfaced
`Messaging provider not registered: telegram` to whoever is
debugging a silent daemon, with **no indication of what was
actually configured** — the worst place for a dead-end error
because the failure is already remote/unattended.

The existing registry test only asserted the error `code`
(`PROVIDER_NOT_FOUND`) and type, never the message text, so the
enriched message introduces **no wrong premise**; the
recoverability of this error was untested.

## Slice

- `packages/messaging/src/registry.ts` — `require()` appends
  `registeredHint([...this.providers.keys()])`:
  ` (registered: a, b)` when providers exist, ` (none
  registered)` when empty — **byte-identical wording to goal
  472's `@muse/voice` `registeredHint`** (single cross-package
  convention, not a re-derivation). The `MessagingProviderError`
  **code is unchanged** (`PROVIDER_NOT_FOUND`), so code-branching
  callers, `send()`'s rejection contract, and the existing
  `toMatchObject({ code })` / `toThrow` assertions are
  unaffected.
- `packages/messaging/test/messaging.test.ts` — extended the
  existing `MessagingProviderRegistry` describe (prior tests
  untouched): empty registry → `/none registered/`; a populated
  registry with a typo'd id (`telgram`) →
  `/registered: telegram/`.

## Verify

- New test green; the pre-existing registry tests still green
  (no wrong premise — they assert `code`/type, not message);
  full `@muse/messaging` suite green (148, +1, 0 failed); tsc
  strict (messaging) EXIT=0.
- **Clean-mutation-proven** (Edit-based): neutralising
  `registeredHint` to `""` makes the new test fail with the
  precise pre-fix symptom (`expected [Function] to throw error
  matching /none registered/ but got 'Messaging provider not
  registered: telegram'`) while the pre-existing registry tests
  stay green; fix restored, suite back to green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure registry logic — no LLM / model request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A misconfigured messaging providerId now yields
`Messaging provider not registered: x (registered: telegram)` —
so an operator debugging a silent proactive/reminder/objectives/
inbound daemon immediately sees the valid ids and whether the
provider was simply not wired. Two of the four
goal-472-identified sibling registries (`voice`, now
`messaging`) are discharged; `@muse/calendar` and `@muse/mcp`
tasks/notes remain (ledger line updated). Error codes and all
success paths unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an error-UX `fix:` continuing the
goal-472 actionable-error slice, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Picked messaging first among the remaining three siblings: it
  is the only one on the unattended autonomous-actuator path
  (daemons), so a dead-end there is the costliest to debug —
  highest leverage per the tight one-package-per-iteration
  budget.
- Reused goal 472's exact `registeredHint` wording/shape rather
  than a variant: the actionable-error message must read
  identically across registries; a near-variant is the drift
  the single-pattern rollout exists to prevent.
- Updated (not re-appended) the goal-472 Rejected-ledger line to
  strike `messaging` and point remaining work at
  `calendar` + `mcp` tasks/notes — keeps the ledger accurate
  without bloating it; the discovery is still preserved for the
  next iteration.
