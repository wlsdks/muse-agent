# 534 — `muse orchestrate run --workers ",,"` omits empty `workerIds` from the API body instead of sending `workerIds: []` (CLI ergonomics)

## Why

`apps/cli/src/commands-orchestrate.ts:56` parsed the `--workers
<ids>` flag with a defensive trim+filter:

```ts
const workerIds = options.workers
  ? options.workers.split(",").map((id) => id.trim()).filter((id) => id.length > 0)
  : undefined;
```

…then forwarded it to the API:

```ts
...(workerIds ? { workerIds } : {}),
```

`workerIds ?` is a **truthy** check, and `[]` is truthy in JS.
So a user passing `--workers ","` (a stray comma — easy
copy-paste mistake, common shell-pipeline glitch when a
variable expanded to empty) produced `workerIds = []`, which
got forwarded to the API as `{ workerIds: [] }`.

The API's `/api/multi-agent/orchestrate` route
(`apps/api/src/multi-agent-routes.ts:140`) uses the **same**
truthy check pattern: `requestedIds ? allSpecs.filter(...) :
allSpecs`. With an empty `requestedIds = []`, the filter
matches nothing, `selected.length === 0`, and the route 409s
with:

```
NO_AGENT_WORKERS
"No enabled agent specs match the requested workerIds"
```

…even though the operator's intent was "no constraint, use
all workers." The error message is misleading: it claims the
ids don't match anything, when the real issue is that there
ARE no ids. The user sees a 409 they don't understand.

## Slice

- `apps/cli/src/commands-orchestrate.ts` — replace the truthy
  spread with a length check:
  ```ts
  ...(workerIds && workerIds.length > 0 ? { workerIds } : {}),
  ```
  Behaviour byte-identical for every input where `--workers`
  produces at least one non-empty trimmed id. Only the
  effectively-empty path (`","`, `",,  ,  "`, etc.) is closed:
  `workerIds` is omitted from the body so the API receives
  the same shape as the no-`--workers` invocation.
- `apps/cli/src/commands-orchestrate.test.ts` — added two new
  tests:
  - `--workers ",,  ,  "` produces a body with no `workerIds`
    property (asserts the omission, not just the value)
  - `--workers "  alpha , beta , "` produces
    `workerIds: ["alpha", "beta"]` (sanity: the happy path still
    works after trim+filter)

## Verify

- New tests 2/2 green; full `@muse/cli` suite green (903
  passed, +2 vs baseline 901, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to the
  bare `workerIds ?` truthy check makes the new test fail
  with the precise pre-fix symptom — `an effectively-empty
  --workers must be omitted from the body, not sent as
  workerIds: []: expected { message: 'hello', …(2) } to not
  have property "workerIds"` (the `[]` shows up in the body
  because `[]` is truthy and the spread fires). Fix restored,
  suite back to 5 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI request-body builder — no LLM request-response
  wire path; `smoke:live` does not apply (per `testing.md`
  / iteration-loop Step 9). The defended path is
  `POST /api/multi-agent/orchestrate`, not the model loop.

## Status

Done. A stray-comma typo on `--workers` no longer produces
a confusing `NO_AGENT_WORKERS` 409. The operator's intent
("no worker constraint") now produces the same request shape
as omitting `--workers` entirely.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a CLI-ergonomics `fix:` on
the orchestrate request-body builder, recorded honestly with
this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the tiebreaker run (530 / 531 / 533)
  to a CLI-ergonomics defect class (empty-array truthy-leak)
  on a fresh surface. Productive variation, not same-area
  churn.
- Fixed the CLI side, not the API side: the API's truthy
  check at line 140 of multi-agent-routes.ts is correct for
  what it tests — "filter to a subset if a subset is
  requested, otherwise use all." Changing the API would
  alter the contract for other callers (the web UI, a
  future scripted client). The narrower fix is on the
  client that's producing the bad shape.
- Used `workerIds && workerIds.length > 0` (explicit length
  check) rather than `workerIds?.length`: the former reads
  as "exists and is non-empty"; the latter as "optional
  chain returns a length, which when zero is falsy" — same
  semantics, but the explicit check is clearer at the call
  site. The `&&` chain is the established cross-package
  pattern (see `commands-actions.ts:53` and goal 532's
  `firstNonEmpty`).
- Did NOT change the trim+filter at line 56-58 — it's
  already correct. The defect was at the spread, where the
  truthy check yielded to `[]`.
- Mutation reverts only the spread token (`workerIds ?`)
  back to its pre-fix shape; the test failure (`expected
  body to NOT have property "workerIds"`) reproduces the
  pre-fix observable byte-for-byte — the API would receive
  `{ workerIds: [] }` and 409.
