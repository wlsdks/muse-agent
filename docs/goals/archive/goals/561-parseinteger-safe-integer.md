# 561 — `parseInteger` (env-parsers) uses `Number.isSafeInteger` so out-of-range env values fall back instead of silently rounding

## Why

Step-8 redirect onto a fresh package — `packages/autoconfigure` —
with a different defect class from the recent sweep
(comparator-determinism, persona CLI, calendar validation,
trim-symmetry). The defect class is **integer-overflow safety**
inside the existing strict-parse contract.

Pre-fix `parseInteger`:

```ts
const trimmed = value.trim();
if (!/^[+-]?\d+$/u.test(trimmed)) {
  return fallback;
}
const parsed = Number(trimmed);
return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
```

`Number.isInteger` returns `true` even for values that lost
precision in the double-conversion. Concrete trip-wire:

- `Number("9007199254740993")` (2^53 + 1) → 9007199254740992
  (rounded to 2^53). `Number.isInteger(9007199254740992)`
  returns true. The function happily returns 9007199254740992
  — silently dropping the +1.
- `Number("9999999999999999999")` (20-digit value) → ~1e19,
  rounded to a representable double. Still passes
  `Number.isInteger`.

Real-world callers: `MUSE_CACHE_MAX_SIZE`,
`MUSE_CACHE_TTL_MS`, `MUSE_SLO_WINDOW_SECONDS`,
`MUSE_PROACTIVE_AGENT_TURN_*`, etc. — every numeric runtime
knob hits this parser. A programmatic typo or an operator
who confuses `_` separators with a long literal
(`9_999_999_999_999_999_999` → `"9999999999999999999"`) gets
a silently-wrong number rather than the documented
fallback. The strict-parse contract goal-414 / goal-540
established is "invalid → fallback"; double-precision-
truncated isn't "valid in any useful sense".

`Number.isSafeInteger` is the precise predicate: returns
true only when the value can round-trip through Number
exactly. Switching `isInteger` → `isSafeInteger` makes the
fallback win on the rounded-precision-loss case.

## Slice

- `packages/autoconfigure/src/env-parsers.ts:60` — changed
  `Number.isInteger(parsed)` to `Number.isSafeInteger(parsed)`.
  Added a 4-line WHY comment explaining the precision-loss
  trip-wire (the kind of comment policy-allows: WHY,
  non-derivable from the code).
- `packages/autoconfigure/test/autoconfigure.test.ts` —
  added one `it(...)` covering: `"9007199254740993"`
  (2^53 + 1, lost +1 in rounding) → fallback;
  `"9999999999999999999"` (20-digit, ~1e19) → fallback;
  `"9007199254740992"` (2^53 itself, ALSO outside safe
  range) → fallback; `"9007199254740991"`
  (`Number.MAX_SAFE_INTEGER` exactly) → accepted;
  `"1000000"` (everyday value) → accepted.

## Verify

- New `it(...)` green; full `@muse/autoconfigure` suite green
  (143 passed, +1 vs baseline 142, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `isSafeInteger` → `isInteger` makes the new test fail with
  the precise pre-fix symptom — `expected 9007199254740992
  to be 100` (the function returns the rounded value 2^53
  instead of falling back). Fix restored, suite back to
  all green (143 passed).
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1000 passed, packages/autoconfigure 143
  passed); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the three
  intended files.
- Pure env-var parser — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is every
  `MUSE_*` numeric env-var loader (cache sizes, TTLs,
  thresholds, intervals) in `autoconfigure`'s runtime-
  assembly factory, not the model loop.

## Status

Done. The integer strict-parse contract is now precision-
safe end-to-end: regex-gated decimal-only input, double-
parsed, and only accepted when the double round-trips
exactly. A future grep for `Number.isInteger(` in
`packages/autoconfigure` should return zero hits (only
`isSafeInteger`); the integer parser is the canonical site.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all
P-bullets are already `[x]` and audited; a
precision-safety hardening on the env-parser strict-parse
gate, recorded honestly with this backlog row — not a false
metric.

## Decisions

- `isSafeInteger` is exactly the predicate the contract
  needs. Alternative considered: round-trip check
  (`parsed.toString() === trimmed`). Rejected: that
  requires equivalent normalisation (`"007".toString() ===
  "007"` is false — `"007"` becomes `7`, fails round-trip
  even though the value is semantically valid). The regex
  gate above already filters lexical noise; the
  precision-safety check is purely about the numeric
  conversion.
- Did NOT widen the `parsed > 0` constraint. The function
  contract is "positive integer or fallback"; that's
  separate from the safety question. A signed test
  (`"-3"` → fallback) is already covered by the existing
  test block and remains valid.
- The 2^53-itself test case asserts FALLBACK (not
  acceptance). `Number.MAX_SAFE_INTEGER` is `2^53 - 1`,
  not `2^53`, so `2^53` (9007199254740992) is OUTSIDE the
  safe range by one. This is correct: every integer in
  `[2^53, 2^54)` shares its representation with its
  neighbour, so accepting one would let the parser
  silently accept the rounded form of two different
  inputs. The test pins this boundary so a future "let's
  be lenient up to 2^53" patch can't slip past.
- One WHY comment added (the trip-wire). Comment policy
  allows this: it explains WHY `isSafeInteger` (the
  precision-loss trip-wire); the code itself doesn't
  carry that information.
