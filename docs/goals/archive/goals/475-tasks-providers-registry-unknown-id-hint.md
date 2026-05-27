# 475 — `@muse/mcp` tasks-providers registry unknown-id error names the registered providers (goal-472/473/474 sibling slice)

## Why

Continuation of the goal-472/473/474 actionable-error rollout
explicitly logged in the Rejected ledger. `@muse/voice` (472),
`@muse/messaging` (473), and `@muse/calendar` (474) were
discharged; only `@muse/mcp` tasks-providers and notes-providers
remained on the hint-less
`Tasks provider not registered: <id>` dead-end.

`TasksProviderRegistry.require(providerId)` is the resolution
point on three live user-facing surfaces at once:

- **proactive imminence (P8-b3)** — `deriveBriefingImminent`
  feeds the situational briefing's `Upcoming:` from a tasks
  provider; a misconfigured id silently strips the upcoming-task
  grounding the briefing rests on.
- **accountability log (P6-b1)** — autonomous actuators that
  mark a task as done resolve via `require()`; a typo'd id
  leaves a `(unknown)` action-log entry with no recovery hint.
- **`muse tasks` CLI** — `commands-tasks.ts` calls into a
  provider id read from config; a typo lands on a dead-end
  message instead of an actionable list of what was wired.

The existing tasks-registry test only asserted
`toThrow(TasksProviderError)` (not the message text), so the
enriched message introduces **no wrong premise**; the
recoverability of this error was untested.

## Slice

- `packages/mcp/src/tasks-providers.ts` — `require()` appends
  `registeredHint([...this.providers.keys()])`:
  ` (registered: a, b)` / ` (none registered)` — **byte-identical
  wording to goals 472/473/474** (single cross-package
  convention, not a re-derivation). The `TasksProviderError`
  **code is unchanged** (`PROVIDER_NOT_FOUND`), so code-branching
  callers, the apps/api / `commands-tasks` error mapping, and
  existing assertions are unaffected.
- `packages/mcp/test/mcp.test.ts` — extended the existing
  `TasksProviderRegistry` describe (prior test untouched): empty
  registry → `/none registered/`; populated with `local` → a
  typo'd id (`locale`) → `/registered: local/`.

## Verify

- New test green; the pre-existing registry test still green
  (no wrong premise — it asserts error type, not message text);
  full `@muse/mcp` suite green (506, +1, 0 failed); tsc strict
  (mcp) EXIT=0.
- **Clean-mutation-proven** (Edit-based): neutralising
  `registeredHint` to `""` makes the new test fail with the
  precise pre-fix symptom (`expected [Function] to throw error
  matching /none registered/ but got 'Tasks provider not
  registered: local'`) while the pre-existing registry test
  stays green; fix restored, suite back to green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure registry logic — no LLM / model request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A misconfigured tasks `providerId` (briefing daemon, action
log, or `muse tasks`) now yields
`Tasks provider not registered: x (registered: local)` — the
operator immediately sees the valid ids and whether the provider
was simply not wired. **`@muse/mcp` notes-providers is the last
remaining sibling** (ledger line updated). Error codes and all
success paths unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an error-UX `fix:` continuing the
goal-472 actionable-error slice, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Picked tasks-providers before notes-providers (both live in
  `@muse/mcp`): tasks is on three live surfaces at once
  (proactive imminence, accountability log, `muse tasks` CLI)
  while notes serves recall / RAG only — strictly higher
  user-leverage per the tight one-file-per-iteration budget.
- Reused goals 472/473/474's exact `registeredHint`
  wording/shape rather than a variant: the actionable-error
  message must read identically across registries; a
  near-variant is the drift the single-pattern rollout exists
  to prevent.
- Updated (not re-appended) the goal-472 Rejected-ledger line to
  strike `tasks-providers` — keeps the ledger accurate without
  bloating it; the remaining notes-providers work is preserved
  for the next iteration to fully discharge the slice.
