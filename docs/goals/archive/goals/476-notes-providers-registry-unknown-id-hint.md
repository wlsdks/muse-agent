# 476 — `@muse/mcp` notes-providers registry unknown-id error names the registered providers (fully discharges the goal-472 slice)

## Why

The fifth and **final** sibling slice of the goal-472 cross-package
actionable-error rollout. `@muse/voice` (472),
`@muse/messaging` (473), `@muse/calendar` (474), and
`@muse/mcp` tasks-providers (475) were discharged in order;
`@muse/mcp` `NotesProviderRegistry.require` was the last
remaining throw of the hint-less
`Notes provider not registered: <id>` dead-end.

`NotesProviderRegistry.require(providerId)` is the resolution
point for the **recall / RAG path** — `commands-recall.ts` /
`commands-notes.ts` / `commands-notes-rag.ts` consult the user's
configured notes provider (apple / notion / local-dir), and the
RAG / `muse recall` surfaces all funnel through `require()`. A
typo'd or unconfigured notes provider id therefore surfaced a
dead-end message with no indication of what providers were
actually wired — the same failure mode 472/473/474/475 closed
elsewhere.

The existing `NotesProviderRegistry` registry test only asserted
`toThrowError(NotesProviderError)` (not the message text), so the
enriched message introduces **no wrong premise**; the
recoverability of this error was untested.

## Slice

- `packages/mcp/src/notes-providers.ts` — `require()` appends
  `registeredHint([...this.providers.keys()])`:
  ` (registered: a, b)` / ` (none registered)` — **byte-identical
  wording to goals 472/473/474/475** (single cross-package
  convention, not a re-derivation). The `NotesProviderError`
  **code is unchanged** (`PROVIDER_NOT_FOUND`), so code-branching
  callers, the MCP / recall / RAG error mapping, and existing
  assertions are unaffected.
- `packages/mcp/test/mcp.test.ts` — extended the existing
  `notes provider abstraction` describe (prior test untouched):
  empty registry → `/none registered/`; populated with
  `AppleNotesProvider` → a typo'd id (`aple`) →
  `/registered: apple/`.

## Verify

- New test green; the pre-existing registry test still green
  (no wrong premise — it asserts error type, not message text);
  full `@muse/mcp` suite green (507, +1, 0 failed); tsc strict
  (mcp) EXIT=0.
- **Clean-mutation-proven** (Edit-based): neutralising
  `registeredHint` to `""` makes the new test fail with the
  precise pre-fix symptom (`expected [Function] to throw error
  matching /none registered/ but got 'Notes provider not
  registered: apple'`) while the pre-existing registry test
  stays green; fix restored, suite back to green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure registry logic — no LLM / model request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A misconfigured notes `providerId` (recall / RAG /
`muse notes` / `muse notes-rag`) now yields
`Notes provider not registered: x (registered: apple)` — the
operator immediately sees the valid ids and whether the provider
was simply not wired. **The goal-472 cross-package
actionable-error slice is fully discharged** across all five
sibling registries (voice → messaging → calendar →
mcp/tasks-providers → mcp/notes-providers); the ledger line is
closed.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an error-UX `fix:` finishing the
goal-472 sibling slice, recorded honestly with this backlog row
— not a false metric.

## Decisions

- Closed (not just trimmed) the goal-472 Rejected-ledger entry:
  no remaining package carries the hint-less dead-end, so the
  deferral is fully discharged and the ledger now records that
  fact instead of pointing at phantom remaining work.
- Reused goals 472/473/474/475's exact `registeredHint`
  wording/shape rather than a variant — the actionable-error
  message must read identically across the five registries; a
  near-variant after four consistent fixes would be exactly the
  drift the single-pattern rollout exists to prevent.
- Did NOT fold a "consolidate registeredHint into a shared
  helper" refactor: the helper is 1 line × 5 files and lives in
  a different package than three of its users (`@muse/shared`
  would have to absorb it). The cost of a cross-package barrel
  for a one-liner is greater than the duplication; deferred
  unless a sixth caller appears.
