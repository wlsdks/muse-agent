# 229 — inbox + attachment context sanitizers must strip control / ANSI bytes

## Why

Closes the control-byte-strip sweep started in goals 227
(episodic) and 228 (active-context). The remaining two
prompt-context chokepoints had the **identical** bug —
`sanitizeInline` was `value.replace(/\s+/gu, " ").trim()`
(inbox-context) / `value.replace(/\s+/gu, " ")`
(attachment-context):

- `inbox-context.ts`: sanitises `providerId`, `source`,
  `sender`, `receivedAtIso`, and **`message.text`** before
  rendering the `[Recent Messages]` system-prompt block.
  Inbound message text is **directly attacker-controllable** —
  anyone who can message the bot (Telegram / Slack / Discord /
  Line) — the most exposed surface of all four.
- `attachment-context.ts`: sanitises attachment `name` /
  `mimeType` / `ref` / `description` before the
  `[Attached Files]` block (both at parse time via
  `sanitizeAndBound` and at the render boundary).

`\s+` collapse neutralises the `\n[System Override]\n`
section-splice (documented / tested) but does NOT match
non-whitespace control bytes — ESC (0x1b), the rest of C0
(0x00-0x08), C1 (0x80-0x9f), DEL (0x7f). A poisoned inbound
message / attachment name carrying those survived into the
model's system prompt AND the user's terminal when the
context was printed (ANSI execution / title hijack).

## Scope

- `packages/agent-core/src/inbox-context.ts` and
  `packages/agent-core/src/attachment-context.ts`: compose the
  shared `stripUntrustedTerminalChars` (@muse/shared — already
  used by episodic-recall 227 + active-context 228) into each
  `sanitizeInline`, control bytes stripped first then the
  existing whitespace collapse (+ trim where it already had
  one). Clean / whitespace-only inputs unchanged, so every
  existing newline-splice / parser / render / DoS-cap test
  still passes; no duplicated regex. Identical shape to goals
  227 / 228 (one coherent sweep — same bug class, two
  parallel files).
- Each test file gets a new control-byte regression: a
  poisoned `message.text` (inbox) / attachment `name` +
  `description` carrying ESC / BEL / C1-CSI / NUL / DEL (built
  via `String.fromCharCode`, no raw bytes in source) AND the
  `\n[System Override]\n` splice → the rendered block contains
  no byte in `0x00-0x08, 0x0b-0x1f, 0x7f-0x9f` and still only
  the one real section header line.

## Verify

- `pnpm --filter @muse/agent-core test` — 529 pass (2 new;
  existing inbox / attachment / newline-splice / DoS-cap tests
  unchanged → no regression).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Deterministic prompt-sanitisers: model invocation
  unchanged; the new tests assert the exact injected
  `[Recent Messages]` / `[Attached Files]` text is
  control-byte-free via the public render functions
  (authoritative per the testing rules). No smoke:live — same
  stance as 197 / 208 / 209 / 227 / 228.

## Status

done — all FOUR prompt-context chokepoints (episodic 227,
active-context 228, inbox-context + attachment-context 229)
now reuse the shared `stripUntrustedTerminalChars`. The
most attacker-exposed of them — inbound message text — can no
longer carry ANSI / C0 / C1 / DEL bytes into the prompt or the
terminal; the newline-splice defence is preserved everywhere.
The control-byte-strip sweep is complete.
