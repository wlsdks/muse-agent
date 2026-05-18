# 363 — the dueAt "unrecognized phrase" error advertised a stale, narrow grammar

## Why

`parseTaskDueAt` (the shared resolver behind `muse task --due`,
`muse remind`, and followups) returns an actionable error on an
unparseable phrase whose `Examples:` list is the **primary
discovery surface** for the relative-time grammar — a user who
gets it wrong learns what they *can* say from this string, not
from docs (goal 186's intent).

But that example set —
`"tomorrow 9am", "in 3 hours", "next monday 6pm", "내일 오후
3시", "3일 후", "다음 주 월요일"` — predated **nine** grammar
expansions (goals 329 bare-hour, 330 article, 331 second, 332
day-parts, 344 standalone day-parts, 345 bare time, 356
month-name dates, 358 fractional durations, 362 day-after-
tomorrow). So a user who typed e.g. `May 20`, `in half an
hour`, or `day after tomorrow`, got the phrase **rejected**,
then shown a hint that *didn't mention any of the now-supported
forms* — they'd never discover the capabilities that exist.
Verify-and-rejected several mature/tested candidates first
(import path / isSafeMuseEntry / chat / top-level did-you-mean /
uniqueCommandPrefix — all already covered).

## Scope

`packages/mcp/src/personal-tasks-store.ts` — the
`parseTaskDueAt` error string only:

- Refreshed the `Examples:` set to surface the now-rich grammar
  across families: keep `"tomorrow 9am"` + the three Korean
  ones (no test churn — `mcp.test.ts:2046/2049/2050/2051` pin
  the prefix + those), and add `"in half an hour"` (358),
  `"at 5pm"` (345), `"day after tomorrow"` (362),
  `"this evening"` (344), `"May 20"` / `"Dec 25 at 3pm"`
  (356), `"next monday 6pm"`. Concise (one error line, ~12
  examples) and diverse, not exhaustive.

Error-string-only change; no parsing/behaviour touched. Every
advertised example was **empirically verified to resolve**
before committing — an error message that advertises a phrasing
the grammar can't parse would be a worse UX than a stale one.

## Verify

- The existing `parseTaskDueAt` error test
  (`mcp.test.ts:2046`) is extended, **not** broken
  (prefix + `tomorrow 9am` + Korean examples retained):
  asserts the new key phrasings are present **and** adds a
  standing invariant — every quoted phrase after `Examples:`
  is extracted and must `resolveRelativeTimePhrase(...)` to a
  Date. This permanently prevents the message ever again
  advertising a phrasing the grammar can't parse (a
  self-checking user contract).
- Pre-commit empirical check: all 12 examples
  (`tomorrow 9am` … `다음 주 월요일`) resolve OK.
- `pnpm --filter @muse/mcp test` — 363 pass (the existing
  test, extended). `pnpm check` — every workspace green
  (mcp 363, apps/cli 611, apps/api 165, all packages).
  `pnpm lint` — exit 0. The goal-227 enforcement test (328)
  stays green.
- No real-LLM request/response path touched (an error-message
  string). The deterministic invariant test is the rigorous
  verification.

## Status

done — the dueAt error now showcases the genuinely-supported
grammar (fractional / bare-time / day-after-tomorrow /
month-name-date / standalone-day-part), so users discover the
phrasings goals 329-362 built instead of being shown a stale
six-example subset, and a regression test enforces that every
advertised example actually parses.
