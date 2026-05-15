# 178 — `muse ask` strict `--top` / `--calendar-days`

## Why

`muse ask` is a flagship daily JARVIS surface (notes-grounded
Q&A). Two inline parses silently fell back to the default on
bad input — the silent-numeric anti-pattern (goals 143 / 144 /
155 / 177):

- `--top 5x` → silently 3 (user thinks 5 results, gets 3).
- `--calendar-days 14d` → silently 7.

No signal; the user's intent vanished.

## Scope

- `apps/cli/src/commands-ask.ts`:
  - New exported `parseBoundedInt(raw, flag, min, max,
    fallback)`: absent/blank → fallback; a genuine number is
    truncated + clamped to `max`; a non-numeric / below-`min`
    value (unit slip, `abc`, `0`, negative) **throws** with
    `<flag> must be an integer in [min, max] (got '<raw>')`.
  - `--top` → `parseBoundedInt(options.top, "--top", 1, 20, 3)`.
  - `--calendar-days` → `parseBoundedInt(options.calendarDays,
    "--calendar-days", 1, 30, 7)`.
  - High-value-but-genuine numbers still clamp (e.g. `--top
    999` → 20), matching goal-177 `parseLimit` semantics; only
    garbage / unit-slip rejects.
- `apps/cli/src/commands-ask.test.ts` (new): 4 cases —
  absent→fallback, valid+trunc+clamp, unit-slip/non-numeric/
  below-min throw, `--calendar-days` bounds.

## Verify

- `pnpm --filter @muse/cli test` — 456 pass (4 new; no
  regression — the old inline parses had no exact-behaviour
  integration test, unlike goal 177).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (pure numeric parsing; smoke:live
  not required).

## Status

done — the daily-driver `muse ask` joins the strict-numeric
line; a fat-fingered `--top` / `--calendar-days` is a clear
rejection, not a silent wrong result count / window.
