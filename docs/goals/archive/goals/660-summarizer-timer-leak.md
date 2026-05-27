# 660 — `createWorkerSummarizer` (the multi-agent sub-agent output summarizer) stores its 15-second `setTimeout` handle and `clearTimeout`s it in a `finally` so a successful summarize doesn't leave a dangling timer keeping the event loop alive for 15 seconds after every call

## Why

`apps/api/src/multi-agent-routes.ts:createWorkerSummarizer`
wraps a `modelProvider.generate(...)` call in
`Promise.race(...)` against a 15-second timeout. The
timeout was constructed inline:

```ts
new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error("summarizer timeout")),
             SUMMARIZER_REQUEST_TIMEOUT_MS)
)
```

The `setTimeout` return value was discarded — there was no
handle to feed `clearTimeout`. When the model's response
wins the race (the common path), the timer still ticks for
the full 15 seconds before its callback fires.

Consequences:

1. **Event loop pinned**. Node's event loop stays alive as
   long as any timer is pending. A CLI invocation that
   calls the summarizer once, then completes its work, sits
   in `node` for up to 15 extra seconds before exit. The
   user sees `muse multi-agent run` hang at the end with no
   visible progress.
2. **Test-suite flake amplifier**. vitest in `forks` /
   `threads` mode waits for the worker's event loop to
   drain before tearing down. A summarizer-using test
   leaks 15-second timers that don't fire until after the
   test reporter has reported — appearing as a slow test or
   a hung CI runner.
3. **Memory pinning**. The setTimeout callback holds a
   closure reference to `reject` and via that to the
   surrounding Promise. The Promise holds the timer's
   resolver chain. None of that frees until the timer
   fires.
4. **API-server resource cost**. On a busy server doing
   N summarizer calls per minute, the unfired timers
   accumulate up to `15 × N` per minute (each timer takes
   ~100-200 bytes of timer-queue state plus the closure).
   Bounded but unnecessary.

The fix: store the timer handle, `clearTimeout` it in a
`finally` block. The timer fires zero times in the
happy path; the race resolves on the response side, then
finally clears the pending timer.

### Defect class

**Promise.race timer leak (no handle stored, no
clearTimeout)** — first hit at this site. Distinct from
goal 648's `loadFeedBody` fix (that was an HTTP fetch
timeout with the same shape of fix — `clearTimeout` in
`finally` — but at a different layer and applied to fetch,
not Promise.race). Related to "timer cleanup discipline" as
a broad family but the specific bug here is
`Promise.race`-shaped and the test technique (`vi.useFakeTimers`
+ `vi.getTimerCount`) is distinct.

Fresh against the recent 10-iter window:

- 659: HTTP redirect SSRF
- 658: sort comparator tiebreaker
- 657: secret patterns ext (PGP)
- 656: secret patterns ext (PEM)
- 655: path-traversal alt-separator
- 654: PKCE feature
- 653: recursion depth bound
- 652: error msg control-char sanitization
- 651: non-crypto RNG for security token
- 650: LLM timestamp sanity bound

No prior iter touched Promise.race timer cleanup. 648
(HTTP fetch timeout) was 12 iters ago and at a different
layer.

## Slice

- `apps/api/src/multi-agent-routes.ts`:
  - **Exported** `createWorkerSummarizer` so the test file
    can call it directly (the test couldn't go through
    `registerMultiAgentRoutes` without spinning up a real
    Fastify instance).
  - Wrapped the race + return logic in a `try` / `finally`.
  - Stored the timer handle in a `let timer:
    ReturnType<typeof setTimeout> | undefined` declared
    outside the inner `new Promise(...)` executor, assigned
    inside.
  - `finally` block: `if (timer !== undefined)
    clearTimeout(timer);`
- `apps/api/test/multi-agent-sse-stream.test.ts`:
  - Added `import type { ModelProvider, ModelRequest,
    ModelResponse } from "@muse/model"`.
  - Imported `createWorkerSummarizer` from the route file.
  - **New `describe`** "createWorkerSummarizer timer
    hygiene" with three tests:
    1. **Happy-path timer-count assertion** — uses
       `vi.useFakeTimers()` + `vi.getTimerCount()`. The
       stub provider returns immediately, the race
       resolves, and the timer count must be 0 after the
       await (clearTimeout fired). Mutation point.
    2. **Undefined provider** — `createWorkerSummarizer(undefined,
       ...)` returns `undefined`; legacy contract pin.
    3. **Empty-string response fallback** — model returns
       a whitespace-only summary; function falls back to
       the raw output. **AND still clears the timer in
       the finally path** — same `vi.getTimerCount() ===
       0` assertion. Pins that the finally runs on every
       exit path, not just the happy `return text > 0`
       branch.

## Verify

- `pnpm --filter @muse/api test`: 273 passed (270 prior +
  3 new). `pnpm check` full: every workspace green; tsc
  strict EXIT=0.
- **Clean-mutation-proven**: reverting the try/finally
  block (back to the bare race) makes EXACTLY the two
  timer-count assertions fail with the exact symptom —
  `vi.getTimerCount()` returns `1` instead of `0` because
  the 15s timer is still pending. The "returns undefined"
  test passes regardless (it doesn't exercise the timer
  path). Surgical proof. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched — the test
  stub provider returns a synthetic ModelResponse without
  hitting a real model. The summarizer code path is the
  one being fixed; smoke:live exercises this indirectly
  via real multi-agent runs but isn't required for this
  iter (the unit tests are the narrowest proof).

## Status

Done. The summarizer no longer leaves a dangling 15-second
timer after each successful call:

| Scenario                                  | Pre-fix                                  | Post-fix                          |
| ----------------------------------------- | ---------------------------------------- | --------------------------------- |
| Model responds in 100ms                    | timer leaks for 14.9s after return       | clearTimeout fires immediately   |
| Model responds in 14s                      | timer leaks for 1s after return          | clearTimeout fires immediately   |
| Timeout fires (model slow)                 | race rejects with timeout error          | unchanged (timer fired by then)  |
| Empty model response → output fallback     | timer leaks                              | clearTimeout fires (finally)     |
| Model throws (network error)               | timer leaks                              | clearTimeout fires (finally)     |
| CLI `muse multi-agent run` complete time    | up to 15s extra wait at exit             | exits cleanly                    |

## Decisions

- **`let timer` declared outside the inner executor**.
  The `new Promise((_, reject) => { ... })` executor runs
  synchronously when the Promise is constructed, so by the
  time `Promise.race([..., new Promise(...)])` returns, the
  timer handle is already assigned to the outer-scoped
  `timer`. No race between assignment and `finally`.
- **`if (timer !== undefined) clearTimeout(timer)` guard**.
  Defensive — if `new Promise(...)` somehow doesn't run
  its executor (shouldn't happen in practice but bounds
  the worst case), the finally doesn't choke on `undefined`.
  `clearTimeout(undefined)` is actually a no-op in Node,
  but TypeScript strict mode flags it. The guard is the
  TS-clean form.
- **Exported the factory function** rather than building
  a complex integration test through Fastify. Tight
  scope: one function, three unit tests, mutation-provable.
  The export surface is a function reference, used by no
  external consumer beyond the new test.
- **`vi.useFakeTimers()` + `vi.getTimerCount()`** as the
  proof technique. Real timers would either:
  - Slow the test (await 15s real time) — unacceptable.
  - Spawn timers that fire after the test ends — invisible
    to the assertion.
  Fake timers expose the pending-timer count
  deterministically. Same technique vitest's own internals
  use to detect leaks.
- **No `redirect:` / SSRF concerns here**. This is
  in-process race between a model call and a setTimeout —
  no network involvement, no allowlist surface. Distinct
  from 659.
- **Mutation choice**. Reverted the entire try/finally
  block, restoring the pre-fix bare race. The two
  fake-timer tests fail with `getTimerCount() === 1`
  instead of `0`. The "returns undefined" sanity test
  passes regardless. Surgical proof of the cleanup
  branch.

## Remaining risks

- **Other `Promise.race` + `setTimeout` sites**:
  - `packages/memory/src/memory-auto-extract.ts:244`
    (`runWithTimeout`) — DOES store the timer handle in
    `let timerHandle` and clears in finally. Correctly
    implemented.
  - `packages/resilience/src/index.ts:370` — DOES store
    in `let timeout` and clears in finally. Correctly
    implemented.
  - This site (`multi-agent-routes.ts:525`) was the only
    one with the leak. Verified via grep.
- **The 15-second timeout itself is not configurable**.
  An operator running on slow hardware where Ollama
  takes more than 15s per summarize would see false
  timeouts. Future iter could wire
  `MUSE_SUMMARIZER_REQUEST_TIMEOUT_MS` through the
  autoconfigure layer.
- **The summarizer's `text.length > 0 ? text : output`
  fallback** swallows whitespace-only model outputs.
  Acceptable — better to return the raw output than
  hand the orchestrator an empty string. Pinned in the
  new "empty-string response fallback" test.
- **No metric on summarizer latency**. A future iter
  could record this through the telemetry aggregator so
  operators can spot a misbehaving summarizer that
  consistently grazes the 15s ceiling.
