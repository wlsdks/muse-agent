# 621 — pin three contract edges of `createCancellationToken` that weren't covered by tests — `cancel()` default message, `throwIfCancelled()` no-op before cancel, and `throwIfCancelled()` idempotency after cancel — so a regression on any of the three is caught before it ships

## Why

`packages/shared/src/index.ts:createCancellationToken` is the
single primitive every Muse cancellation surface threads
through — the agent run loop's `signal`, the tool runner's
graceful-abort window, the runtime watchdog. Pre-iter the test
covered only one path:

```ts
it("exposes an abort signal with deterministic cancellation errors", () => {
  const token = createCancellationToken();
  expect(token.signal.aborted).toBe(false);
  token.cancel("timeout");
  expect(token.signal.aborted).toBe(true);
  expect(() => token.throwIfCancelled()).toThrow("timeout");
});
```

Three load-bearing edges were unpinned:

1. **`cancel()` with no argument** — the docstring promises a
   default `"Operation cancelled"` message. A regression that
   drops the default (e.g. someone refactors to `cancel(reason:
   string)` removing the default, or changes the default text)
   would silently weaken the error UX for every consumer that
   catches `e.message`.
2. **`throwIfCancelled()` BEFORE cancel** — must be a NO-OP. A
   regression that always throws (dropping the
   `if (controller.signal.aborted)` guard) would break every
   pre-cancellation poll-site that uses `throwIfCancelled` as a
   "checkpoint" mid-loop.
3. **`throwIfCancelled()` idempotency** — repeated polls after
   cancel all throw the same error. A regression that made it
   a one-shot exception (consumed the abort state) would
   surprise caller cleanup loops that poll multiple times.

This is a `test:` iteration — pure additive coverage on an
existing primitive. No source-code change is required because
the production behavior is already correct on all three edges;
the gap is just that the tests didn't pin the contract.

Step-8 redirect: not write-side (617/620), not file-mode (616),
not validation-cleanup (618/619). Defect class is "test
coverage gap on a load-bearing primitive's documented contract"
— a `test:` commit type the iteration-loop contract explicitly
sanctions ("`test:` test-only change") as a valid forward step.

## Slice

- `packages/shared/test/shared.test.ts`:
  - Three new tests appended after the existing
    `exposes an abort signal with deterministic cancellation
    errors` test:
    - **default message** — `cancel()` with no arg, assert
      `throwIfCancelled()` throws the documented `"Operation
      cancelled"`.
    - **no-op before cancel** — fresh token, assert
      `throwIfCancelled()` doesn't throw; repeated polls
      still don't throw.
    - **idempotency after cancel** — `cancel("deadline")`,
      assert three back-to-back `throwIfCancelled()` calls
      each throw `"deadline"` (no exhaustion of the abort
      state).

## Verify

- `@muse/shared` suite green (21 passed, +3 vs baseline 18, 0
  failed); tsc strict EXIT=0.
- **Two mutations clean-mutation-proven** (Edit-based):
  - Dropping the `if (controller.signal.aborted)` guard from
    `throwIfCancelled` (always-throw mutation) — the
    `no-op BEFORE` test fails with `expected [Function] not
    to throw an error`, exactly the pre-fix consumer-poll
    breakage.
  - Changing the default `cancel(reason = "Operation
    cancelled")` to a different default string — the
    `documented default` test fails with the new default in
    the error message instead of the canonical one, exactly
    the message-rot regression the docstring warns about.
- The third test (idempotency) isn't separately mutation-
  proven here because a one-shot mutation that consumed the
  signal would require restructuring with stateful flags —
  out of scope for a single-iter test addition. The contract
  is still pinned: any regression that breaks idempotency
  fails the assertion.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1052
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on the touched test
  file; `git status` shows only the one intended file plus
  this goal doc.
- No LLM request-response wire path touched; `smoke:live`
  does not apply. Tests run against a pure in-memory primitive.

## Status

Done. `createCancellationToken`'s three documented contract
edges are now pinned by tests:

| Contract                                  | Before        | After                       |
| ----------------------------------------- | ------------- | --------------------------- |
| Initial state: `aborted === false`        | tested        | unchanged                   |
| `cancel(reason)` → throws `reason`        | tested        | unchanged                   |
| **`cancel()` → throws default message**   | **untested**  | tested (**new**)            |
| **`throwIfCancelled()` no-op pre-cancel** | **untested**  | tested (**new**)            |
| **`throwIfCancelled()` idempotent**       | **untested**  | tested (**new**)            |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a `test:`
coverage iteration on a load-bearing primitive, recorded
honestly with this backlog row — not a false metric.

## Decisions

- **Three separate `it()` blocks**, not one combined test.
  Each contract is an independent claim; pinning them
  separately makes a regression report name the SPECIFIC
  edge that broke. A combined test would report "the
  cancellation token contract broke" with no localization.
- **Test the documented default string literal** (`"Operation
  cancelled"`), not just "throws SOMETHING". A regression
  that swapped the default to `"unknown"` or empty string
  would still satisfy a loose "throws anything" assertion;
  pinning the literal catches message rot.
- **`expect(() => ...).not.toThrow()`** for the no-op test
  rather than just calling and asserting no exception
  trickled out. The `not.toThrow` matcher makes the
  intent explicit in the test report.
- **Three back-to-back idempotency assertions**, not just
  two. Three is enough to differentiate "one-shot" (passes
  the first, fails the second) from "two-shot" (passes
  the first two, fails the third) regressions. Each form
  of state-consuming bug fails differently.
- **No source-code change.** The production behavior is
  already correct on all three edges. This is purely a
  coverage-hardening iteration — the right kind of
  defensive work the iteration-loop's `test:` Conventional
  Commit type was designed for.
- **Did NOT add a fourth test for the non-Error-reason
  fallback** (external `controller.abort("string")` →
  throws Error wrapper). That edge is reachable only from
  outside the token's own API, requires a separate
  AbortController reference, and the test would be
  hard-to-read (the token's internal controller is
  encapsulated). Out of scope for this iter — separate
  test if a real consumer surfaces the case.

## Remaining risks

- **The non-Error-reason fallback** in `throwIfCancelled` (the
  `reason instanceof Error ? reason : new Error("Operation
  cancelled")` branch) is unpinned by direct test. Reachable
  only via external `controller.abort(string)`; the token's
  own `cancel()` always wraps in Error. Leaving as-is — the
  branch is defensive, not load-bearing.
- **`signal.aborted` after cancel** — the signal IS the
  Node AbortSignal; its `.aborted` getter is contract-
  guaranteed by the Node API, not by Muse. We trust the
  runtime.
- **`cancel()` after cancel** — calling cancel multiple times
  on a token isn't covered. The semantics are "first cancel
  wins, subsequent calls no-op" per Node's AbortController
  contract. A future iter could pin that if a consumer
  surfaces a question, but it's currently a Node
  contract claim, not a Muse one.
