# 741 — fix: Telegram clamps the ESCAPED length, so parse_mode replies near 4096 aren't dropped

## Why

`TelegramProvider.send` clamped the message to Telegram's 4096-char
limit and THEN escaped it for `parse_mode`:

```ts
const outboundText = clampOutboundText(message.text);            // ≤ 4096 UNESCAPED
... text: escapeForTelegramParseMode(outboundText, this.parseMode) // can be > 4096
```

But Telegram's 4096 limit applies to the text actually transmitted —
the ESCAPED text. Escaping expands the body: MarkdownV2 turns each
reserved char into `\X` (up to 2×), HTML turns `&`→`&amp;` (up to 5×).
So a near-limit, special-char-dense reply escapes to >4096 and Telegram
rejects the whole `sendMessage` with a 400 — the message is dropped
whole, the exact failure the clamp was added to prevent. The
`validateOutboundMessage` length guard didn't catch it either: it
checked the pre-escape length. Plain-text sends (no `parse_mode`, the
default) were unaffected.

## Slice

New `clampForTelegram(text, mode)` (exported): plain text → clamp to
4096 directly; with a parse_mode → if the fully-escaped form already
fits, pass through unchanged, else truncate the SOURCE by the
worst-case expansion factor (2 for MarkdownV2, 5 for HTML) so the
escaped result stays ≤ 4096. `send` now uses it. Truncating the
UNescaped source and escaping afterward keeps the truncation marker
valid and can't leave a dangling half-escape, since the cut lands on a
real char boundary before any `\`/entity is added.

## Verify

- `@muse/messaging` messaging.test.ts (new `clampForTelegram` case):
  plain 5000-char body → ≤4096; a 4000×`_` MarkdownV2 body escapes to
  ≤4096 with no trailing dangling `\`; a 2000×`&` HTML body escapes to
  ≤4096; a short body that fits once escaped is passed through
  unchanged. **Mutation-proven** — reverting to clamp-the-source-by-full-4096
  (ignoring escape expansion) makes the MarkdownV2 escaped length exceed
  4096 and fails the test.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). Deterministic
  string clamping on the Telegram outbound HTTP path (not the LLM
  request/response path) — unit + mutation tests are the gate, no
  `smoke:live`.

## Decisions

- **Truncate the source, then escape — don't escape then truncate** —
  escaping-then-truncating could cut mid-escape (a dangling `\` /
  partial `&amp;` → its own 400) and would need a parse-mode-aware
  marker. Cutting the unescaped source at a char boundary sidesteps
  both: the marker and body are escaped together as one valid string.
- **Conservative worst-case factor over a binary search** — the
  over-limit path is rare (only genuinely huge, special-dense replies);
  a fixed 2×/5× budget is simple and provably safe. Slight
  over-truncation there is acceptable vs. dropping the message.
