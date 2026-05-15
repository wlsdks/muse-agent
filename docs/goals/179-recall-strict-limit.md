# 179 — `muse recall` strict `--limit`

## Why

`muse recall` is the RAG-search sibling of `muse ask`
(goal 178). Its `clampLimit` silently fell back to 5 on any
bad value — `--limit 10x` / `abc` / `0` → silently 5, masking
the user's intent with no signal. Same silent-numeric
anti-pattern fixed in goals 143 / 144 / 155 / 177 / 178; the
sibling RAG command should behave consistently.

## Scope

- `apps/cli/src/commands-recall.ts`:
  - `clampLimit` now **exported** + strict: absent/blank → 5
    (default, unchanged); a genuine number is truncated +
    clamped to the 50 cap; a non-numeric / non-positive value
    throws `--limit must be a positive number (got '<raw>')`.
    `--limit 999` still clamps to 50 (genuine number), only
    garbage / `0` / negative rejects.
- `apps/cli/src/commands-recall.test.ts`: 3 new cases —
  absent→5, valid+trunc+clamp, unit-slip/non-numeric/
  non-positive throw.
- No `program.test.ts` retrofit: the recall integration tests
  only pass valid args, so nothing encoded the old
  silent-fallback behaviour (unlike goal 177).

## Verify

- `pnpm --filter @muse/cli test` — 462 pass (3 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (pure numeric parsing; smoke:live
  not required).

## Status

done — the RAG pair (`ask` 178 / `recall` 179) is now
consistent; a fat-fingered `--limit` is a clear rejection on
both, not a silent wrong hit count.
