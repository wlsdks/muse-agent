# 275 — cron_for_datetime monthly rule on day 29–31 silently never fired in short months

## Why

`cron_for_datetime` is the bridge an agent uses to turn a
natural-language reminder into a scheduler cron
(`time_now`/`time_add`/`next_weekday` → ISO → `cron_for_datetime`
→ `scheduler_create_job`). In `monthly` mode it emits
`${minute} ${hour} ${dayOfMonth} * *` from the UTC date.

The scheduler runs cron through `cron-parser`
(`CronExpressionParser`), which **skips** — never clamps — a
day-of-month a month lacks. So a flagship personal-assistant
request like *"remind me to pay rent on the 31st every month"*
produces `0 9 31 * *`, which silently never fires in
February / April / June / September / November — the reminder
just vanishes for ~5 months a year with **zero** signal to the
user or the agent. Same silent loss for day 30 (skips February)
and day 29 (skips non-leap February). This is the silent-wrong
class the loop keeps closing (goals 261, 274): a confidently
"successful" tool result that quietly does the wrong thing.

`once` mode (default) is unaffected: it fires on the next real
occurrence of that exact date and is disabled after — the next
Jan 31 / Feb 29 is the correct one-shot target, so no warning is
warranted there. `daily` / `weekly` carry no day-of-month.

## Scope

`packages/tools/src/muse-tools-time.ts` — `createCronForDatetimeTool`:

- When `mode === "monthly"` and the UTC `dayOfMonth > 28`, the
  result now carries a `warning` string explaining the
  short-month skip and recommending a day ≤ 28 for a guaranteed
  monthly run. The model sees this in the tool result and can
  relay/adjust before calling `scheduler_create_job`.
- The emitted `cron` is **unchanged** (still correct for the
  months that do have the day); this only surfaces a non-obvious
  cron foot-gun. A one-line WHY comment records the
  cron-parser-skips-never-clamps rationale (non-derivable from
  the code).
- Tool `description` gains a short parenthetical so the model can
  avoid the foot-gun proactively (pick ≤ 28) without waiting for
  the warning.

Behaviour-preserving for every prior call: `once`/`daily`/`weekly`
and `monthly` with day ≤ 28 return exactly as before (no
`warning` key); only `monthly` day 29–31 gains the advisory
field. No API/schema change.

## Verify

- `pnpm --filter @muse/tools test` — 66 pass (1 skipped). The
  existing `cron_for_datetime` test keeps its `once`/`daily`/
  `weekly`/`monthly`(day 15) assertions green and now also
  asserts: monthly day-15 has **no** `warning`; monthly day-31
  (`2026-01-31`, `0 9 31 * *`) carries a `warning` containing
  "31" and "February"; the same date as a one-shot (`once`)
  carries **no** warning.
- `pnpm check` — every workspace green (tools 66, apps/cli 561,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (deterministic
  tool-output enrichment + static tool-description metadata; the
  tool-registration test pins the description). A live Qwen run
  cannot deterministically exercise the short-month branch on
  demand, so the deterministic unit tests are the rigorous
  verification — same stance as goals 261 / 274.

## Status

done — `cron_for_datetime` now flags a monthly schedule on
day 29–31 with a `warning` instead of silently emitting a cron
that disappears for ~5 months a year, so the agent can warn the
user (or pick a safe day) before the reminder is created. The
cron output and all other modes are unchanged.
