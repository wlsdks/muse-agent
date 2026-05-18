# 362 — the relative-time grammar couldn't parse "day after tomorrow"

## Why

A fresh probe of the latest grammar (post 356/358) showed
`day after tomorrow` → `undefined`. It is one of the most
common, completely unambiguous scheduling phrasings ("remind
me the day after tomorrow", "task due day after tomorrow at
3pm"), and an **English/Korean asymmetry**: the grammar
already resolves the Korean equivalent `모레` (+2 days) via
`resolveKoreanRelativePhrase`, but the English phrase fell into
the bare-`[a-z]+` `dayPattern` branch — `WEEKDAY_INDEX["day"]`
is `undefined` → the whole phrase aborted. Verify-and-rejected
the chat-route probe first (already mature/guarded).

## Scope

`packages/mcp/src/loopback-relative-time.ts` — one pre-check
before `dayPattern` (the established 344/345/356 slot):

- `/^(?:the\s+)?day\s+after\s+tomorrow(?:\s+(?:at\s+)?(.+))?$/`
  → `reference + 2 days`, with the optional trailing time run
  through the existing `parseTimeOfDay` (no time → 09:00, the
  same bare-day default as "tomorrow"; a malformed trailing
  time → `undefined`, not a silent default — consistent with
  the month-date resolver, goal 356).

Disjoint by construction: anchored regex; `tomorrow` /
weekdays / month-dates / bare-time / Korean don't match it and
still route through their existing handlers (verified
unchanged). Case-insensitive for free (`trimmed` is already
lowercased). Forward-only — there is no useful single-phrase
"+3"/past form for scheduling ("in 3 days" already works;
Korean 글피 is its own path).

## Verify

- Empirically dog-fooded on the rebuilt dist before the test:
  `day after tomorrow` / `the day after tomorrow` → +2 days
  09:00; `... at 3pm` → +2 days 15:00; `Day After Tomorrow at
  noon` → 12:00; `day after tomorrow garbage` → `undefined`;
  `tomorrow` (+1) / `in 2 days` / `next monday` /
  `today at 3pm` all byte-unchanged.
- `pnpm --filter @muse/mcp test` — 363 pass (was 362; +1). New
  test pins +2-days, the/at-time/case-insensitive forms,
  malformed-time → undefined, and the `tomorrow` no-regression.
- `pnpm check` — every workspace green (mcp 363, apps/cli
  611, apps/api 165, all packages). `pnpm lint` — exit 0. The
  goal-227 enforcement test (328) stays green.
- No real-LLM request/response path touched — deterministic
  input-phrase parsing; the resolved `Date` feeds the
  reminder/task stores. The deterministic regression (plus the
  pre-write dist dog-food) is the rigorous verification.

## Status

done — the relative-time grammar now resolves "day after
tomorrow" (+2 days, optional trailing time), closing a
ubiquitous unambiguous scheduling-phrasing gap and the
English/Korean (모레) asymmetry; "tomorrow", weekdays, and all
prior forms are unchanged.
