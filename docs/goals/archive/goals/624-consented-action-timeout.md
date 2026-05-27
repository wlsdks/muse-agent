# 624 — `performConsentedAction` wires an `AbortController + setTimeout` so a hung consented endpoint can't stall the standing-objective loop indefinitely past the next-tick cadence

## Why

`packages/mcp/src/consented-action.ts:performConsentedAction` is
the security boundary between a standing objective ("when the
release is tagged, open the changelog issue") and the user's
actual scoped credential. After the veto + consent gates pass
fail-closed, the function makes a real HTTP call carrying the
bearer token:

```ts
const response = await options.fetchImpl(options.request.url, {
  body: options.request.body,
  headers: {
    authorization: `Bearer ${options.credential}`,
    ...
  },
  method: options.request.method ?? "POST"
});
return { performed: true, status: response.status };
```

No `signal`. No timeout. A consented endpoint that hangs —
network partition between the user's laptop and api.github.com,
a misbehaving upstream that ACKs but never closes the response,
a SOCKS proxy with a leaked file descriptor — blocks
`performConsentedAction` indefinitely. The standing-objective
loop (`runDueObjectives`) calls the action sequentially per
objective; one hung call stalls every subsequent objective's
next-tick evaluation.

User-visible symptom: a user with three standing objectives
(`obj_changelog`, `obj_pr_notify`, `obj_weekly_review`) where the
first hits a hung consented endpoint never sees the second and
third evaluate. The personal-JARVIS loop quietly stops making
progress with no diagnostic.

Same defense pattern as goal 600 (`muse.fetch` loopback timeout)
— `AbortController + setTimeout` covering the fetch with a hard
wall-clock cap. Goal 600 is 24 commits back, outside the last-10
window; the HTTP-timeout family is fresh.

## Slice

- `packages/mcp/src/consented-action.ts`:
  - New `timeoutMs?: number` option on
    `PerformConsentedActionOptions`. Default 30_000ms — generous
    for typical consented API calls (GitHub PR open, Slack
    message post) but bounded so a hung endpoint surfaces within
    half a minute.
  - After consent check passes:
    - Create an `AbortController`, schedule
      `controller.abort()` at `timeoutMs`.
    - Pass `signal: controller.signal` into the fetch init.
    - `try / catch / finally`: on fetch throw, check
      `controller.signal.aborted` — true ⇒ return
      `{ performed: false, reason: "consented action timed out
      after Nms" }`; false ⇒ return
      `{ performed: false, reason: "consented action fetch
      failed: <message>" }`. Either way the loop sees a
      structured outcome instead of an unhandled exception.
    - `finally: clearTimeout(timer)` — always release the
      scheduled abort, success or failure.
  - The catch/return shape composes with the existing
    `runDueObjectives` test pattern (line 145-147 / 180-182 of
    consented-action.test.ts): the caller's `act` wrapper turns
    `!outcome.performed` into a thrown error, the loop then
    keeps the objective active and moves on.
- `packages/mcp/src/consented-action.test.ts`:
  - One new test in the existing `performConsentedAction`
    describe. Records consent first, then mocks `fetchImpl` as
    a Promise that only resolves via its abort signal (a
    never-closing endpoint). With `timeoutMs: 50`, asserts the
    outcome is `{ performed: false, reason: /timed out after
    50ms/ }` within a 2_000ms wall-clock bound. Pre-fix the
    test hangs until vitest's 5_000ms test-level timeout fires,
    surfacing as a "Test timed out in 5000ms" failure.

## Verify

- `@muse/mcp` suite green (534 passed, +1 vs baseline 533, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the timeout
  wiring back to the bare `await options.fetchImpl(...)` makes
  the new test fail with `Error: Test timed out in 5000ms` —
  exactly the standing-objective-loop-stall symptom documented
  above (the call hangs until vitest aborts the entire test).
  Fix restored, suite back to 534/534.
- `pnpm check` EXIT=0 (apps/api 261 passed, apps/cli 1062
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched directly; the
  consented-action surface fronts a USER-scoped third-party
  API (GitHub / Slack / etc.) — not the model loop.
  `smoke:live` doesn't apply.

## Status

Done. The consented-action surface is now time-bounded across
every failure mode:

| Scenario                                   | Before                  | After                       |
| ------------------------------------------ | ----------------------- | --------------------------- |
| Endpoint responds within timeout (ok)      | `{ performed: true, status }` | unchanged             |
| Endpoint returns 4xx/5xx                   | `{ performed: true, status: 4xx }` (caller decides) | unchanged |
| Endpoint refuses TCP (ECONNREFUSED, etc.)  | uncaught throw          | `{ performed: false, reason: "...fetch failed..." }` (**fixed**) |
| **Endpoint hangs (no response ever)**      | **uncaught hang**       | `{ performed: false, reason: "...timed out…" }` (**fixed**) |
| Veto matches before consent check          | `{ performed: false, reason: "vetoed..." }` | unchanged |
| No recorded consent                        | `{ performed: false, reason: "no recorded consent..." }` | unchanged |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
loop-bound `fix:` on the consented-action security boundary,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **30_000ms default**, not the 5_000ms goal 600 used for
  loopback-fetch. Consented actions are user-scoped third-party
  APIs (GitHub PR open, Slack message post) — a 5s cap would
  flap on slow legitimate calls. 30s is generous for the
  happy path and sharp enough that a hung endpoint surfaces
  within half a minute.
- **Catch fetch errors and return structured outcomes**, not
  rethrow. The existing `runDueObjectives.act` wrapper at line
  145-147 / 180-182 of the test file demonstrates the
  contract: callers expect `{ performed: false, reason }` and
  turn it into a soft error that keeps the objective active.
  Rethrowing would force every consumer to add a try/catch.
- **Distinguish "timed out" from "fetch failed" in the reason**
  via `controller.signal.aborted`. The operator needs to know
  whether the endpoint actively refused (DNS, ECONNREFUSED) or
  silently hung — they're different root causes and different
  remediation paths.
- **`signal: controller.signal` passed in init**, not threaded
  through a separate fetch-with-signal wrapper. The existing
  fetch impls in production (Node's global fetch, undici)
  respect the spec's signal contract; the test fixture in
  `consented-action.test.ts` also threads through. The simpler
  shape is the right shape.
- **Test uses an abort-listener mock**, not a setTimeout-based
  one. A scheduling-based mock (e.g. `await new Promise(r =>
  setTimeout(r, 200))` for 200ms) would risk flakiness on a
  slow CI box. The abort-listener pattern is fully
  deterministic — the mock resolves IFF the abort fires.
  Same pattern goal 600 uses.
- **Generous 2_000ms wall-clock bound** on the test (vs the
  50ms timeoutMs). Allows for scheduling slop and the fetch
  promise's microtask flush; pre-fix this bound is comfortably
  exceeded (the 5_000ms vitest timeout).
- **Mutation choice.** Reverted exactly the try/catch/finally
  wrapper back to the bare `await fetchImpl(...)` shape. The
  mutation reproduces the pre-fix call site — a maintainer
  "simplifying back to a one-line await" lands the same diff.
  The mutation test catches it with the exact 5_000ms test
  timeout failure.

## Remaining risks

- **Total `timeoutMs` budget includes BOTH connect + body
  read**, like goal 600's loopback-fetch fix. A slow body
  read past the 30s cap is captured. Same as the loopback
  semantics; consistent.
- **No retry on timeout** — a single timeout surfaces as
  `not performed`. The standing-objective loop's next-tick
  evaluation will retry on the next cron tick; multi-retry
  policy lives at that layer, not here.
- **`options.request.headers`** can still override the
  `authorization` header (spread comes AFTER the bearer
  assignment in the merged object). That's a caller-controls-
  caller-data path — the caller owns its credential — but a
  defensive future iter could pin "authorization is reserved"
  with a runtime check.
- **The user's scoped credential is never logged in the
  reason string** even on timeout/fetch-failure. The reason
  contains the URL + error message but never the bearer
  token. Verified by inspection of the formatted message
  templates — both branches stringify only the cause /
  timeoutMs, never `options.credential`.
