# 335 — math_eval rejected tab/newline whitespace its own validator admits

## Why

`math_eval` is a deterministic agent tool — a wrong or
spuriously-failing result silently corrupts the JARVIS answer.
Input is gated by `MATH_EXPRESSION = /^[\s\d+\-*/().,%]+$/u`,
which admits the **full `\s` class** (space, tab, newline, CR,
form-feed, …). But the recursive-descent evaluator's
`skipWhitespace` only consumed a literal `" "`:

```ts
while (cursor < stripped.length && stripped[cursor] === " ") cursor += 1;
```

So a perfectly valid expression containing a tab or newline
passed validation and then **errored in the parser**. Confirmed
empirically against the built tool:

- `"2 +\t3"` → `{"error":"expected number"}` (should be `5`)
- `"10 *\n2"` → `{"error":"expected number"}` (should be `20`)
- `"  4\t*\t(1+1) "` → `{"error":"trailing characters after
  expression"}` (should be `8`)

Copy-pasted math, an LLM-generated expression with a newline, or
tab-formatted input are all plausible real inputs — the agent
got a confident, wrong "invalid expression" for valid
arithmetic. A validator/parser asymmetry: the regex says yes,
the parser says no.

## Scope

`packages/tools/src/muse-tools-data.ts`:

- New module constant `MATH_WHITESPACE = /\s/u` and
  `skipWhitespace` now skips while the char matches it. Using
  the **same `\s` semantics** as `MATH_EXPRESSION` makes the two
  symmetric *by construction* — any whitespace the validator
  admits, the parser now consumes; no hand-maintained character
  enumeration that can drift. One short WHY comment records the
  validator-symmetry rationale (non-derivable).

Behaviour-preserving for every space-separated and
comma-grouped expression (space is in `\s`, so the prior
behaviour is a strict subset); only tab/newline/other-`\s`
inputs — previously spurious errors — now evaluate correctly.

## Verify

- `pnpm --filter @muse/tools test` — 69 pass (+1; 1 pre-existing
  skip). New test: `"2 +\t3"` → 5, `"10 *\n2"` → 20,
  `"  4\t*\t(1 +\n1) "` → 8, and `"7 * 6"` → 42 (plain-space
  no-regression). The existing precedence / parens / modulo /
  thousands-separator / reject-unsafe-chars math_eval tests stay
  green.
- `pnpm check` — every workspace green (tools 69, apps/cli 563,
  apps/api 161, all packages). `pnpm lint` — exit 0. The
  goal-227 enforcement test (328) stays green.
- End-to-end re-verified on the rebuilt dist: the four bug
  cases now return correct results; space/comma cases unchanged.
- No real-LLM request/response path touched — `math_eval` is a
  deterministic tool, not a model round-trip. The deterministic
  unit suite + dist re-verification are the rigorous
  verification.

## Status

done — `math_eval` now consumes the same whitespace class its
input validator admits, so tab/newline-containing arithmetic
evaluates correctly instead of erroring; space/comma behaviour
is unchanged and the asymmetry can't silently regress (shared
`\s` semantics).
