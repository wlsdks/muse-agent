# 444 — Float env-parsers reject lenient-garbage like `parseInteger` (goal 414 sibling)

## Why

`env-parsers.ts` (`@muse/autoconfigure`) declares the module
contract (lines 10–12): "Each parser takes `string | undefined`
and a fallback. None throws — invalid input maps to the
fallback." Goal 414 hardened `parseInteger` because
`Number.parseInt` is lenient: `"60x"` → `60`, `"16k"` → `16`, so
a typo'd / unit-slipped `MUSE_*` env var silently mis-configured
the runtime (the 414 docstring calls a `num_ctx` slip
"catastrophic").

Its three **float siblings** — `parseSloErrorRate`,
`parsePositiveFloat`, `parseNonNegativeFloat` — were left on
`Number.parseFloat`, which has the identical leniency:

```
Number.parseFloat("0.5x") === 0.5
Number.parseFloat("60s")  === 60
Number.parseFloat("0x")   === 0     // passes parseNonNegativeFloat's `>= 0` gate
```

So `parsePositiveFloat("0.5x", fallback)` returned `0.5`, not the
fallback — exactly the contract violation and the exact footgun
414 fixed for the int parser, on the parsers that drive SLO
error-rate, drift deviation threshold, and budget limits
(`createApiServerOptions` / runtime assembly). The 414 / 428 /
443 sibling-asymmetry class ("fix one, the sibling carrying the
identical concrete gap"); fresh package (autoconfigure last
touched goal 427, ~17 iterations ago); fully unit-verifiable
(pure functions, no PG / no LLM).

A grep confirmed the three float parsers had **zero** direct test
coverage — only `parseInteger` was tested (the 414 work) — so
this is a real `fix:` that also closes a genuine coverage gap,
not a redundant test.

## Slice

- `packages/autoconfigure/src/env-parsers.ts` — a `strictFloat`
  helper (parallel to 414's strict-`Number()` approach): trim,
  empty/whitespace → `NaN`, else `Number(trimmed)` (which, unlike
  `parseFloat`, rejects trailing garbage). The explicit
  empty-string guard preserves the prior
  `parseFloat("")→NaN→fallback` — `Number("")===0` would
  otherwise make `parseNonNegativeFloat("")` return `0` instead
  of the fallback. Applied in all three float parsers; their
  existing finiteness/range guards are untouched, so behaviour is
  identical for every valid float (incl. whitespace, sign,
  leading-dot, scientific) and only lenient-garbage now maps to
  the fallback.
- `packages/autoconfigure/test/autoconfigure.test.ts` — a new
  `it` beside the 414 `parseInteger` test (the three float
  parsers imported directly from `../src/env-parsers.js`, since
  the index barrel re-exports only the original four — no
  public-surface change): unit-slip/garbage → fallback (incl. the
  `"0x"` `>= 0`-gate trap), valid floats still parse, empty /
  whitespace / undefined → fallback, range/finiteness guards
  intact.

## Verify

- New `it` green; full `@muse/autoconfigure` suite 140 passed
  (+1); tsc strict (autoconfigure) EXIT=0.
- **Mutation-proven teeth**: reverting just `parsePositiveFloat`
  to `Number.parseFloat` makes the new test fail with exactly
  `AssertionError: expected 0.5 to be 9`
  (`parsePositiveFloat("0.5x", 9)`); `strictFloat(value)`
  occurrence count went 3→2 then restored to 3, suite back to
  140 green.
- `pnpm check` EXIT=0, every workspace green (autoconfigure 140,
  cli 737, api …) — no regression, confirming behaviour-identical
  for valid input across every consumer; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  only the two intended files.
- Pure deterministic env-string parsing — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. A typo'd or unit-slipped float `MUSE_*` env var
(`MUSE_SLO_ERROR_RATE_THRESHOLD=0.5x`,
`MUSE_DRIFT_DEVIATION_THRESHOLD=2x`,
`MUSE_BUDGET_MONTHLY_LIMIT_USD=10usd`) now maps to the operator's
stated fallback instead of silently taking a truncated value —
the same protection 414 gave the integer parser, extended to its
float siblings. The env-parser module now honours its own stated
"invalid input → fallback" contract uniformly.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a robustness `fix:` to an existing
config surface (414 sibling), recorded honestly with this
backlog row — not a false metric.

## Decisions

- Used bare `Number(trimmed)` rather than a strict decimal-float
  regex: it already fixes the real threat model (trailing-unit
  slips `0.5x` / `60s`) while preserving every legitimate float
  form (`.5`, `5.`, `1e3`, `+2.0`, surrounding whitespace) that
  a hand-written regex would risk dropping. Hex (`0x10`→16) is
  outside 414's stated threat model (trailing-unit typos) and not
  worth the regex complexity/risk — noted, not chased.
- Imported the float parsers directly from `../src/env-parsers.js`
  in the test rather than widening the index barrel: keeps the
  change to src-fix + test with zero public-surface delta. The
  4-vs-7 barrel asymmetry is a separate, debatable API-surface
  question, deliberately not scope-crept into a bug fix.
