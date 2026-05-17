# 311 — Telegram send set parse_mode but never escaped the text (silent delivery failure)

## Why

`TelegramProvider.send` is how Muse delivers reminders /
proactive notices / answers to the user over Telegram. When the
operator configures `parseMode: "MarkdownV2"` (or `"HTML"`) to
get formatted messages, `send` set `parse_mode` on the
`sendMessage` body but passed `text: outboundText` **completely
unescaped**.

Telegram's MarkdownV2 requires *every* occurrence of
`_ * [ ] ( ) ~ \` > # + - = | { } . ! \` to be backslash-escaped
in message text; an unescaped reserved char makes `sendMessage`
return `400 Bad Request: can't parse entities`. Essentially
every real message contains a `.` or `-` ("Meeting at 3 p.m.",
"follow-up") — so with `parseMode` set, **nearly every proactive
notice / reminder silently failed to deliver**: `send` threw
`MessagingProviderError`, the firing daemon logged a failure, and
the user simply never got the message. HTML mode had the same
problem with `< > &`.

## Scope

`packages/messaging/src/telegram-provider.ts`:

- Add `escapeForTelegramParseMode(text, mode)`:
  `"MarkdownV2"` → backslash-escape the reserved-char set
  (incl. `\` itself, the escape char); `"HTML"` → `&`→`&amp;`
  then `<`→`&lt;`, `>`→`&gt;`; unset → identity. Apply it to the
  `text` field in `send`, **after** clamp + validate (Telegram's
  4096 limit counts the parsed/un-escaped length, so the added
  backslashes don't push it over). One short WHY comment records
  the 400-on-reserved-char rationale. Re-exported from the
  messaging barrel for direct coverage.

Behaviour-preserving: with no `parseMode` the helper is the
identity, so plain-text sends are byte-identical to before (the
existing `text:"hi"` send test stays green).

## Verify

- `pnpm --filter @muse/messaging test` — 124 pass (was 122;
  +2). New: with `parseMode:"MarkdownV2"`, sending
  `"Meeting at 3 p.m. — follow-up (room A)!"` puts
  `"Meeting at 3 p\\.m\\. — follow\\-up \\(room A\\)\\!"` +
  `parse_mode:"MarkdownV2"` on the wire (pre-fix: raw text → a
  guaranteed Telegram 400). Direct
  `escapeForTelegramParseMode` unit test pins MarkdownV2 / HTML /
  unset / literal-backslash. The existing no-parseMode send /
  401 / offset / inbound tests stay green.
- `pnpm check` — every workspace green (messaging 124,
  apps/cli 563, apps/api 161, all packages). `pnpm lint` —
  exit 0.
- No real-LLM request/response path touched (outbound Telegram
  API text escaping). A live Qwen run cannot exercise Telegram's
  entity parser, and a real Telegram round-trip needs workspace
  credentials the project must not commit, so the deterministic
  fake-fetch regression is the rigorous verification.

## Status

done — outbound text is now escaped for the active Telegram
`parse_mode`, so a `MarkdownV2`/`HTML`-configured Telegram
delivery no longer 400s on the `.`/`-`/`(` that appears in
virtually every reminder. Plain-text (no parse_mode) sends are
unchanged.
