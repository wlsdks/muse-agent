# 442 — Pin the full Telegram MarkdownV2 reserved-char escaping contract

## Why

`escapeForTelegramParseMode` (`@muse/messaging`
`telegram-provider.ts`) is **delivery-critical**: Telegram rejects
`sendMessage` with HTTP 400 "can't parse entities" if *any* of the
18 MarkdownV2 reserved characters is unescaped, silently dropping
the whole notice. Telegram (with `parse_mode: "MarkdownV2"`) is a
primary JARVIS proactive-delivery channel, and `.` / `-` / `(`
appear in nearly every notice — a regression here is a *total
silent outage* of proactive notices, not a cosmetic glitch.

The function is correct today (the regex escapes all 18 reserved
chars + the backslash). But the existing test
(`messaging.test.ts` "escapes per mode and is identity when
unset") only asserts **5 of the 18** (`. - ( ) !`) plus the
backslash. The other 13 — `_ * [ ] ~ \` > # + = | { }` — have
**zero assertions**: dropping any one of them from the regex
passes the entire existing suite while every Telegram notice
containing that char silently 400s in production.

This is the sanctioned 407 / 424 / 438 / 439 class — partial-only
coverage of a delivery-critical correctness contract (directly
parallel to goal 439, where `math_eval`'s test block existed but
its keystone branch was unasserted). Not speculative, not
already-covered (verified: the 13 chars + the over-escape
direction + the HTML ampersand-first ordering have no existing
assertion). Fresh package — messaging last touched goal 421/422,
~20 iterations ago, so no same-area churn.

## Slice

- `packages/messaging/test/messaging.test.ts` — one new `it`
  beside the existing partial test (not a rewrite of it):
  - every one of the 18 MarkdownV2 reserved chars, asserted
    **individually** (bare `ch` → `\ch`, and embedded `xchy` →
    `x\chy`) so removing any single char from the regex fails
    here, not silently in prod;
  - a set of non-reserved chars (letters, digits, space, `@ : /
    , % " ' & < ?`, a Hangul syllable) asserted **unchanged** —
    an over-eager regex that corrupts message readability also
    fails;
  - HTML mode: `<&>` → `&lt;&amp;&gt;` and `&lt;` → `&amp;lt;`
    (pins ampersand-first ordering) and quotes/dots/underscores
    untouched (Telegram HTML text mode needs only the triple);
  - empty string is identity under every mode.
- No `src` change — the escaper is already correct; this pins the
  contract so it stays correct.

## Verify

- New `it` green; full `@muse/messaging` suite 146 passed (11
  files, +1 it); tsc strict (messaging) EXIT=0.
- **Mutation-proven teeth**: removing `|` from the MarkdownV2
  character class (clean single-char Edit, not the whole regex)
  makes the new test fail with exactly
  `AssertionError: expected '|' to be '\|'`; source then restored
  byte-identical via `git checkout` (empty `git diff --stat`),
  suite back to 146 green. The per-char assertions are not
  vacuous.
- `pnpm check` EXIT=0, every workspace green (messaging 146,
  cli 737, api …); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows ONLY the one test file
  (src untouched).
- Pure deterministic string escaping — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. The Telegram MarkdownV2 escaping contract — the gate on
whether *any* proactive notice is delivered at all when
`parse_mode: MarkdownV2` is active — now has exhaustive,
mutation-proven direct coverage of all 18 reserved chars, the
over-escape direction, and the HTML ordering invariant. A
refactor that drops or broadens a single char now fails a fast
test instead of silently blacking out proactive delivery.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; test-coverage hardening of an existing
delivery-critical mechanism, recorded honestly as a
`test(messaging):` change with this backlog row — not a false
metric (the 434 / 438 / 439 precedent).

## Decisions

- Added a new `it` rather than expanding the existing 5-char one:
  the existing test also pins the embedded-context behaviour
  ("a\\.b\\-c …") and the send-flow integration; keeping them
  separate makes the "full reserved-char contract" intent legible
  and avoids churning a passing assertion.
- Asserted each char individually (loop) instead of one combined
  18-char string: a combined-string expectation still fails if
  one char regresses, but the individual form makes the failure
  message name the exact offending character — faster triage for
  the fresh agent who hits it.
- Did the mutation check with a precise Edit after a crude `perl`
  pass mangled the whole character class (cascading unrelated
  failures): a discrimination proof must isolate the one branch,
  not break the regex wholesale. Recorded transparently.
- Left the speculative non-finite-`max` concerns in
  `clampOutboundText` / `clampInboundLimit` alone: no caller
  passes a non-finite `max`, so guarding it would be the
  defensive-without-observed-failure churn the contract bans —
  explicitly out of scope, not overlooked.
