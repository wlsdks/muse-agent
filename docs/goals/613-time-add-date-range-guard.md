# 613 — `time_add` tool returns a clean `{ error }` when a finite-but-huge offset overflows the Date range, instead of throwing `RangeError: Invalid time value` out of the tool

## Why

`packages/tools/src/muse-tools-time.ts:createTimeAddTool` is the
`time_add` Muse tool — the agent calls it to add a signed
duration (`milliseconds`, `seconds`, `minutes`, `hours`, `days`)
to a base ISO-8601 timestamp. `readOptionalNumber` already
defends against `NaN` / `Infinity` (coerces to 0) so the
existing test pins those edges.

But finite-but-huge values slip through. `days: 1e20` is finite —
`readOptionalNumber` happily passes it through — then:

```ts
const result = new Date(base.getTime() + offsetMs);
return { iso: result.toISOString(), offsetMs };
```

`base.getTime() + 1e20 * 86_400_000 ≈ 8.64e27` ms. The JS Date
type only represents `±8.64e15` ms (≈ ±275,760 years from the
epoch). `new Date(out-of-range)` yields an Invalid Date — and
`result.toISOString()` then throws `RangeError: Invalid time
value` straight out of the tool's `execute` function.

The agent (and any executor wrapping the tool call) sees an
uncaught exception instead of a structured `{ error }` payload
it can recover from — a Qwen / GPT model handed
`time_add({ days: 1e20 })` (a plausible hallucination, or a chained
calculation that overflowed upstream) crashes the tool loop with
a stack trace instead of getting a clean "out of range" hint.

Step-8 redirect: not boolean-spelling (612), not validation-gate
(610/611), not finite-clamp (609 — that was a multiplication
clamp on cost; this is a Date-range overflow check). Defect
class is "computed Date escapes the representable range; the
unguarded `toISOString()` crashes the synchronous tool execute
boundary" — adjacent to goal 602 (Invalid-Date in followup
detector) but on a different surface (a tool execute returning
structured errors, not an event emitter dropping invalid
promises). 602 was 11 commits back; fresh enough.

## Slice

- `packages/tools/src/muse-tools-time.ts:createTimeAddTool`:
  - Added one branch between `new Date(...)` and the
    `toISOString()`:
    ```ts
    if (Number.isNaN(result.getTime())) {
      return { error: "computed date is outside the representable range" };
    }
    ```
  - `Number.isNaN(date.getTime())` is the canonical Invalid-Date
    detection (an Invalid Date's `getTime()` returns NaN). The
    short, generic error message mirrors the existing
    "base must be a valid ISO-8601 string" / "weekday is
    required" style other tools in this file use.
- `packages/tools/test/tools.test.ts`:
  - One new test in the `time_add` block, placed right before
    the existing "non-numeric offsets" test (the natural
    neighbor — both pin pathological-input behavior). Loops
    over the positive-overflow (`days: 1e20`) and
    negative-overflow (`days: -1e20`) cases, asserts each
    returns `{ error: <something containing "range"> }`.
    Tail-asserts that a sane positive value (`days: 1`)
    still works — pins the happy path stays unchanged.

## Verify

- `@muse/tools` suite green (73 passed, +1 vs baseline 72, 1
  always-skipped real-runner test, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the
  `Number.isNaN(result.getTime())` guard makes the new test
  fail with `RangeError: Invalid time value` thrown from
  `muse-tools-time.ts:136:28` (the `result.toISOString()`
  call) — exactly the uncaught-exception symptom documented
  above.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1042
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. `time_add` is a synchronous tool, not the model
  loop.

## Status

Done. The `time_add` tool now returns structured errors
across every pathological input shape:

| Input shape                       | Before                                | After                       |
| --------------------------------- | ------------------------------------- | --------------------------- |
| Unparseable `base`                | `{ error: "...ISO-8601..." }`         | unchanged                   |
| `days: NaN` / `Infinity`          | `{ iso: base, offsetMs: 0 }` (clamp)  | unchanged                   |
| `days: "junk"`                    | coerced to 0 (partial)                | unchanged                   |
| **`days: 1e20` (finite overflow)**| **throws `RangeError`**               | `{ error: "...range" }` (**fixed**) |
| **`days: -1e20` (finite underflow)**| **throws `RangeError`**             | `{ error: "...range" }` (**fixed**) |
| Sane finite offset                | structured `{ iso, offsetMs }`        | unchanged                   |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
tool error-surface `fix:` on the time-arithmetic tool, recorded
honestly with this backlog row — not a false metric.

## Decisions

- **`Number.isNaN(result.getTime())`, not `result instanceof
  Date && !isNaN(result.getTime())`.** The `new Date(...)`
  result is always a Date by construction; the only
  invariant we need to test is "valid time value." Skipping
  the instanceof check makes the post-construct intent
  cleaner.
- **Single-line guard, not extracted helper.** One call site,
  one branch — extracting a `validDate(x): x is Date` helper
  would be premature. If a second consumer in this file
  needs the same check, that's when to extract.
- **Generic error message** ("outside the representable
  range"), not date-math-specific ("days too large"). The
  same overflow can come from any single field or their sum
  — naming "days" in the error would mislead a caller who
  overflowed by `milliseconds: 1e25`. The message tells the
  user WHAT happened (overflow) without pinning a wrong
  CAUSE.
- **Don't restrict at the input layer.** I considered
  bounding `readOptionalNumber` to a "reasonable" range
  (e.g. ±1e10 ms = ~317 years), but that'd silently truncate
  legitimate edge cases (e.g. astronomical timestamps,
  long-running scheduling math). The right place to fail is
  AT the boundary where the result becomes invalid, so the
  error names the actual problem.
- **Test placement.** Added BEFORE the existing
  "unparseable base / non-numeric offsets" test, not after.
  Reads naturally as "first the catastrophic case (overflow,
  throws), then the non-numeric coercion case." Same
  describe, no new test block.
- **Mutation choice.** Reverted exactly the three-line guard.
  The mutation reproduces the pre-fix shape — the realistic
  regression a maintainer might write while "removing the
  guard because the existing input-side NaN/Infinity clamp
  seems to cover it." The mutation test catches that
  misjudgment with the exact RangeError stack-trace symptom.
- **Symmetric positive + negative overflow assertions.**
  Both directions are reachable (`days: -1e20` produces an
  Invalid Date too). Asserting both pins that the guard
  isn't accidentally one-sided (e.g.
  `if (result.getTime() > Number.MAX_SAFE_INTEGER)` would
  pass positive but miss negative).

## Remaining risks

- **Other time tools** (`time_diff`, `time_relative`,
  `next_weekday`, the cron-for-datetime tool) take ISO
  strings as inputs and compute Date math on them.
  `readRequiredDate` filters out parse-failures upstream,
  but a `next_weekday` with a base near the upper bound of
  Date could overflow when adding 7 days. Spot-check;
  spec-pin in a separate iter if a real case surfaces.
- **`time_add` doesn't bound `offsetMs` itself** — it just
  catches the post-`new Date` overflow. A caller summing
  many huge finite values could in theory hit Number
  precision loss BEFORE the Date conversion. Same family
  as goal 608; out of scope here.
- **`createCronForDatetimeTool`** also chains a Date through
  ISO formatting; if a `'once'` mode call near the Date
  upper bound produces an Invalid Date, the same crash path
  would surface. Not audited here.
