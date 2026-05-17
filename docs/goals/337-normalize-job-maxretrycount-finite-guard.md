# 337 — a non-finite persisted maxRetryCount made a scheduled job silently never dispatch

## Why

Direct sibling of goal 336, found by grepping the
`?? <default>`-on-a-numeric-field pattern. `normalizeScheduledJob`
(the normalize/load path every persisted, saved, updated, and
DB-row-mapped job flows through) resolved:

```ts
maxRetryCount: input.maxRetryCount ?? defaultRetryCount,
```

`??` only catches `null`/`undefined` — **not `NaN`/`Infinity`**.
A corrupt / hand-edited / legacy-schema persisted job whose
`maxRetryCount` is `NaN` passes straight through. Then
`SchedulerJobRunner.runWithRetry` (`index.ts:321`):

```ts
const attempts = job.retryOnFailure ? Math.max(1, job.maxRetryCount) : 1;
for (let attempt = 1; attempt <= attempts; attempt += 1) { … dispatch … }
```

`Math.max(1, NaN)` is **`NaN`**, so `1 <= NaN` is `false` — the
loop body **never executes**, `dispatchByType` is never called,
and the runner falls straight to
`throw new SchedulerExecutionError("Job '<name>' failed")`. A
`retryOnFailure: true` job with a corrupt `maxRetryCount`
therefore **silently never runs its actual work and emits a
generic "failed" every fire**, with no real attempt and no
actionable cause — the same severe silent-never-fire class as
goals 317/318.

`validateRetryConfig` guards only the *create/register* path
(`index.ts:239`), not this normalize/load path — the exact
"load doesn't re-validate what create validated" shape of goals
316/317/318/336, and the "`??` doesn't catch NaN" class of
280/284/289/308/310/336.

## Scope

`packages/scheduler/src/scheduler-helpers.ts` —
`normalizeScheduledJob`:

- Resolve `maxRetryCount` via
  `typeof input.maxRetryCount === "number" &&
  Number.isFinite(input.maxRetryCount) ? input.maxRetryCount :
  defaultRetryCount` (hoisted const, matching the file's
  existing compute-above-return style). A finite number —
  **including `0` / negatives**, which remain
  `validateRetryConfig`'s domain — passes unchanged;
  `undefined`/`null` → default (unchanged); only `NaN`/`±Infinity`
  now fall back. One short WHY comment records the
  `Math.max(1, NaN)` → never-dispatch rationale (non-derivable).

Behaviour-preserving except for the bug: the fix changes only
previously-NaN/Infinity inputs, mirroring goal 336's
`resolveJobTimeout` guard exactly. Single fix point — the
normalizer is the boundary the save / update / Kysely-row-map
paths all funnel through.

## Verify

- `pnpm --filter @muse/scheduler test` — 55 pass (was 53; +2).
  New `describe`: finite (incl. `0`) passes through; omitted →
  default (`>= 1`); `NaN` / `+Infinity` / `-Infinity` → default
  (the guard). Adds direct coverage to a previously
  incidentally-only-exercised normalizer field.
- `pnpm check` — every workspace green (scheduler 55,
  apps/cli 563, apps/api 161, all packages). `pnpm lint` —
  exit 0. The goal-227 enforcement test (328) stays green.
- No real-LLM request/response path touched — deterministic
  job normalization. The deterministic suite is the rigorous
  verification (a live run can't manufacture a corrupt persisted
  retry count) — same stance as the non-finite sweep siblings.

## Status

done — `normalizeScheduledJob` now rejects a non-finite
`maxRetryCount` and falls back to the default, so a corrupt
persisted job can no longer `Math.max(1, NaN)`-poison the retry
loop into never dispatching; finite (incl. 0/negative) and
absent values are unchanged. The non-finite-`??` / load-revalidate
class is now closed for both scheduler numeric job fields
(`executionTimeoutMs` goal 336, `maxRetryCount` here).
