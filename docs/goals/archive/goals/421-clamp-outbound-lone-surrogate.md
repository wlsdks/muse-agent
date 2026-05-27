# 421 — `clampOutboundText` never emits a lone surrogate (emoji truncation)

## Why

Robustness fix on a fresh axis (`@muse/messaging` proactive
delivery — the core JARVIS surface that gets reminders /
situational briefings / agent replies to the user; not touched by
the recent cli/mcp/prompts cluster). `clampOutboundText` is the
shared truncator ALL four chat providers (Telegram / Discord /
Slack / LINE) call before sending, precisely so a long message is
"delivered truncated rather than dropped whole".

It sliced on UTF-16 **code units** (`text.slice(0, n)`). When the
truncation boundary falls inside an astral character — an emoji
or CJK-extension char — the slice cuts the surrogate pair in
half, leaving a **lone high surrogate** at the end, immediately
followed by the truncation marker. Probed (built dist), a 📋
(U+1F4CB) straddling the 4096 boundary yields
`…\uD83D… [truncated]`:

```
char before marker: 0xd83d   (lone high surrogate)
valid UTF-16 (no lone surrogate): false
```

A lone surrogate is invalid UTF-8. Telegram's `sendMessage` (and
peers) can reject it with HTTP 400, so the **entire** briefing /
answer is dropped — the exact failure `clampOutboundText` exists
to prevent. And Muse's own proactive notices use astral glyphs
(`📋 {task} due in {N} min`), so a long task title hitting the
cap can trigger it in normal operation.

## Slice

- `packages/messaging/src/provider-helpers.ts` — after the
  code-unit slice (both the normal and the `max ≤ marker` tight
  branch), drop a trailing **unpaired high surrogate** via a tiny
  `dropTrailingLoneHighSurrogate` helper before appending the
  marker. The result is still ≤ `max` (we only ever remove a
  unit), short text is still returned unchanged, and the platform
  code-unit budget semantics are unchanged — the only behaviour
  change is the exact boundary-splits-an-astral-char case, which
  now drops the orphaned half instead of emitting invalid UTF-8.
- `packages/messaging/src/provider-helpers.test.ts` — regression
  in the existing `clampOutboundText` describe: a 📋 straddling
  the cap → no lone surrogate, marker still present, ≤ max; a
  complete trailing emoji that fits is preserved intact; the
  tight-max branch also can't leave a half pair. Fails on the
  pre-fix code (output contained `\uD83D`).

## Verify

- `@muse/messaging` provider-helpers.test.ts 11/11 (+1); full
  `@muse/messaging` suite green (11 files / 143); tsc strict
  (messaging) clean.
- `pnpm check` EXIT=0, every workspace green (messaging ok, api
  194, cli 731, …); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean (📋 is valid UTF-8, not a control byte).
- Pure string helper verified with fixtures; not a real model
  request/response path — no `smoke:live` applies. messaging is
  consumed cross-package so the full `pnpm check` was the gate.

## Status

Done. A long briefing / agent reply whose truncation point lands
on an emoji is now delivered cleanly truncated instead of being
dropped whole by a chat API rejecting the malformed UTF-8 — the
delivery guarantee `clampOutboundText` was written for now holds
even at an astral-char boundary, across all four providers.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a robustness fix to an existing shared
helper, recorded honestly as a `fix(messaging):` change with this
backlog row — not a false metric.

## Decisions

- Trim the orphaned half rather than re-architect to code-point
  truncation: the platform caps (Telegram 4096 etc.) are counted
  in UTF-16 units, so keeping the code-unit budget and only
  removing a trailing lone surrogate is the minimal change that
  is both correct (valid UTF-8) and budget-faithful (≤ max). A
  full code-point rewrite would risk changing the cap semantics
  for no added correctness.
