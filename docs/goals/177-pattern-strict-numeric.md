# 177 — `muse pattern list` strict numeric flags

## Why

`parseLimit` / `parseConfidence` silently fell back to the
default on any bad value — the same silent-numeric anti-pattern
fixed across the CLI in goals 143 / 144 / 155.
`--min-confidence 0.8x` or `1.5` → silently 0 (show
everything); `--limit abc` → silently 20. The user's filter
intent was masked with no signal.

## Scope

- `apps/cli/src/commands-pattern.ts`:
  - `parseLimit` / `parseConfidence` now **exported** + reject
    an explicitly-provided invalid value with a clear message
    (`--limit must be a positive number (got 'abc')`,
    `--min-confidence must be a number in [0, 1] (got '1.5')`).
    Absent / blank → fallback (unchanged); whitespace trimmed.
- `apps/cli/src/commands-pattern.test.ts` (new): 6 cases —
  absent→fallback, valid+cap+trunc, throw on
  non-numeric/0/negative/unit-slip for limit; absent→fallback,
  in-range, throw on out-of-range/non-numeric for confidence.
- `apps/cli/test/program.test.ts`: the existing
  "respects --min-confidence + --limit" integration test
  encoded the OLD buggy behaviour ("1.01 … falls back to 0 —
  still shows clusters"); updated to assert the parseAsync
  rejects with the strict message.

## Verify

- `pnpm --filter @muse/cli test` — 448 pass (6 new + 1
  retrofitted).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (pure numeric parsing; smoke:live
  not required).

## Status

done — `muse pattern` joins the strict-numeric line
(143/144/155); a fat-fingered `--min-confidence` / `--limit`
is now a clear rejection, not a silent wrong filter.
