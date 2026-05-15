# 213 — multi-agent race mode must not hang on a message-bus publish failure

## Why

`MultiAgentOrchestrator.runRace` (parallel-with-first-useful-
answer-wins) had a deadlock bug. Its per-worker `.then`
success handler:

```ts
.then(async (result) => {
  if (resolved) return;
  resolved = true;
  await this.publishWorkerResult(worker.id, result); // <-- can reject
  resolve([{ result, status: "completed", workerId: worker.id }]);
})
.catch(async (error) => {
  if (resolved) return;
  await this.publishWorkerFailure(worker.id, error);  // <-- can reject
  failures.push(...); pending -= 1;
  if (pending === 0 && !resolved) { resolved = true; resolve(failures); }
});
```

`publishWorkerResult` does `await this.messageBus.publish(...)`.
The message bus is **observability**, injectable, and may
reject (custom bus, a throwing subscriber, transient
back-pressure). When it does, in the success path: `resolved`
is already `true`, the `await` throws, the chained `.catch`
runs, sees `resolved === true`, and **returns early without
ever calling `resolve()`**. Every other worker's handler also
early-returns on `resolved === true`, so the race `Promise`
**never settles — `runRace` hangs forever**, hanging the whole
orchestration (and any `runDueProactiveNotices` / orchestrate
caller awaiting it). The all-fail path has the same defect: if
`publishWorkerFailure` rejects, that worker's `pending -= 1`
is skipped, so `pending` never reaches 0 and the failure path
never resolves either.

`runParallel` does not have this bug — its publish is inside
the same try/catch that produces the step result, so a bus
failure just yields a `failed` step. `runRace` was the
inconsistent, fragile one.

## Scope

- `packages/multi-agent/src/index.ts`: make the two publish
  awaits in `runRace` best-effort —
  `await this.publishWorkerResult(...).catch(() => undefined)`
  and the same for `publishWorkerFailure`. The bus is
  observability, not correctness (consistent with how
  `runParallel` already treats a publish failure); the race
  control flow (`resolve()` on first success, `pending`
  decrement → resolve on all-fail) now always proceeds
  regardless of bus outcome. No behavior change when the bus
  succeeds.
- `packages/multi-agent/test/multi-agent.test.ts`: a
  `rejectingBus()` helper + `withHangGuard` (2s) — two
  regression tests: race + a rejecting bus still resolves with
  the winning worker; race where all workers fail + a
  rejecting bus still surfaces `NoAgentWorkerError` (proving
  the `pending` decrement is reached). Before the fix both
  hang (caught by the guard); after, both pass instantly.

## Verify

- `pnpm --filter @muse/multi-agent test` — 44 pass (2 new),
  total runtime ~0.3s (no hang).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Deterministic orchestration control-flow fix; workers are
  `RuleBasedAgentWorker` stubs, no model invoked — the tests
  prove it exactly. No smoke:live needed (consistent with the
  other deterministic robustness goals 196/197).

## Status

done — a transient/observability message-bus publish failure
can no longer deadlock race-mode orchestration; the race
resolves on the first success (or surfaces
`NoAgentWorkerError` when all fail) regardless of bus health,
matching `runParallel`'s resilience.
