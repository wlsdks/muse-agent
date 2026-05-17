# 329 — "tomorrow at 3" failed: the relative-time grammar rejected a bare hour

## Why

`resolveRelativeTimePhrase` (`loopback-relative-time.ts`) is the
natural-language due-at grammar behind reminders / tasks /
followups / calendar — a core JARVIS input surface. Its
`parseTimeOfDay` accepted `noon`, `midnight`, `Nam`/`Npm`
(optionally `:MM`), and 24h `HH:MM`, but a **bare hour** fell
through to `"invalid"`, which aborts the whole phrase:

- `"tomorrow at 3"` → timeSpec `"3"` → `"invalid"` → phrase
  returns `undefined`
- `"today 9"`, `"next monday 7"`, `"tomorrow at 15"` → same

"Remind me tomorrow at 3" is one of the most common ways a
person states a time. Worse, it was an **English/Korean
asymmetry**: the Korean path already documents and supports a
bare 24h hour (`"오늘 15시"` → 15:00), and the English `HH:MM`
branch already accepts the hour range 0–23 — only the bare
English integer was unsupported. The failure was silent at the
grammar layer (caller surfaces a generic "not recognized").

## Scope

`packages/mcp/src/loopback-relative-time.ts` — `parseTimeOfDay`,
one new branch after the `HH:MM` case, before the final
`"invalid"`:

- A bare `\d{1,2}` is read as a **24-hour hour, minute 0**
  (`0–23`; out-of-range → `"invalid"`, consistent with the
  HH:MM guard). No am/pm guessing — the rule is deterministic
  and symmetric with the Korean `시` form and the existing 24h
  branch; a user who means 3pm writes `"3pm"` (already
  supported and still takes precedence, since the am/pm and
  `HH:MM` patterns are matched first).

Tightest possible change: am/pm, `HH:MM`, `noon`, `midnight`,
the `DEFAULT_HOUR=9` bare-day default, and every Korean form are
all untouched and matched ahead of the new branch, so no
existing phrase changes meaning. It strictly converts a set of
previously-`undefined` inputs into the natural result.

## Verify

- `pnpm --filter @muse/mcp test` — 352 pass (was 351; +1). New
  test: `"tomorrow at 3"` → 03:00, `"tomorrow at 15"` → 15:00,
  `"today 9"` → 09:00, `"next monday 7"` → Monday 07:00,
  `"tomorrow at 0"` → 00:00, `"tomorrow at 24"` → `undefined`
  (out-of-range stays unrecognized), and `"tomorrow at 3pm"` →
  15:00 (am/pm still wins — no regression). The existing
  am/pm / HH:MM / noon / midnight / no-`at` / Korean /
  out-of-range-offset suites stay green.
- `pnpm check` — every workspace green (mcp 352, apps/cli 563,
  apps/api 161, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched — this is
  deterministic input-phrase parsing; the resolved `Date` feeds
  the reminder/task stores, not a model round-trip. The
  deterministic regression is the rigorous verification.

## Status

done — the relative-time grammar now accepts a bare 24h hour
("tomorrow at 3" → 03:00), closing a very common JARVIS phrasing
gap and the English/Korean asymmetry, with am/pm and all prior
forms unchanged and precedence preserved.
