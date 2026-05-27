# 417 — Bare Korean time phrase ("오후 5시") resolves to today

## Why

User-facing correctness/consistency fix on a fresh axis (the
shared natural-language time parser `loopback-relative-time.ts` —
never touched by the recent prompts/model/autoconfigure cluster),
high leverage: `resolveRelativeTimePhrase` backs `parseTaskDueAt`
→ `parseReminderDueAt`, so it is the grammar for **every**
`muse remind <when>` and task `--due` across CLI local mode, the
REST routes, and `muse today`.

Probing the parser at `now = 2026-05-19 10:00 KST` exposed an
EN/KO asymmetry for the project's **primary user language**:

```
at 5pm        → 2026-05-19 17:00   (English bare time → today)
5pm           → 2026-05-19 21:00   (English bare time → today)
noon          → resolves
오후 5시       → NULL   ← user error, despite…
내일 오후 5시   → resolves            (Korean WITH a day word works)
정오 / 자정    → NULL   (English noon/midnight resolve)
```

`resolveKoreanRelativePhrase` required a day word
(`오늘|내일|모레|글피`), a weekday, or a `<N>단위 후/뒤`
duration — it had **no bare-time → today** branch, even though
the English path explicitly does (the "bare time with no day
word → today" block) and `parseKoreanTimeOfDay` already fully
parses `오후 5시` / `정오` / `자정` / `17시` / `오전 9시 30분`
(proven by the day-prefixed cases working). The code's own stated
intent — "Korean is the user's native input language; '내일 오후
3시' must resolve as readily as 'tomorrow 3pm'" — was unmet for
the standalone form: `오후 5시` did not resolve as readily as
`5pm`.

## Slice

- `packages/mcp/src/loopback-relative-time.ts` — when the Korean
  day-word pattern misses, fall back to `parseKoreanTimeOfDay(
  phrase)`; if valid, resolve to **today at that time** via the
  same `startOfDay(reference)` + `setHours` the day-word path
  uses. This is the exact Korean counterpart of the English
  bare-time branch — no past-roll (matching English bare-time
  behaviour precisely; this is a pure consistency fix, not a
  policy change). Non-time Korean / English / garbage still
  returns `"invalid"` → `undefined` → falls through to the
  English path unchanged (no false positives, no regression).
- `packages/mcp/test/mcp.test.ts` — regression in the
  `resolveRelativeTimePhrase` describe: `오후 5시` / `정오` /
  `자정` / `17시` / `오전 9시 30분` resolve to today at the right
  hour; non-time Korean ("아무거나") stays `undefined`. Fails on
  the pre-fix code (every bare Korean time was `undefined`).

## Verify

- `@muse/mcp` `resolveRelativeTimePhrase` describe 21/21 (the
  prior 20 + 1 new); the new bare-Korean-time cases fail pre-fix.
- `pnpm check` EXIT=0, every workspace green (api 194, cli 717,
  …); tsc strict (mcp) clean; `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean (Hangul is normal UTF-8).
- Deterministic NL date parser verified with fixtures. Not a
  model request/response path — no `smoke:live` applies.

## Status

Done. `muse remind 오후 5시 "약 먹기"` (and task `--due 오후 5시`,
`정오`, `자정`, `17시`, `오전 9시 30분`) now resolves to today at
that time instead of erroring out — Korean standalone times
resolve as readily as their English equivalents, fulfilling the
parser's own bilingual contract for the primary user language.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a correctness/consistency fix to an
existing parser, recorded honestly as a `fix(mcp):` change with
this backlog row — not a false metric.

## Decisions

- Reused `parseKoreanTimeOfDay` + `startOfDay` rather than adding
  new parsing: the parser was already complete; the only gap was
  routing. Minimal, and it cannot drift from the day-word path
  (same helpers, same semantics).
- Deliberately did NOT bundle the separate "bare time already
  past today → roll to tomorrow" question (it affects English
  `at 9` too and is a debatable policy change). This goal is
  scoped strictly to the EN/KO consistency defect; the past-roll
  is a distinct future slice if judged worthwhile.
