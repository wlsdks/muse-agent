# Goal 926 — `muse inbox` strips terminal-control sequences from attacker-controlled email fields

## Outward change

`muse inbox` (the listing) and `muse inbox <id>` (full read-out) now
strip ESC / C0 / C1 / DEL bytes from the email's `From`, `Subject`,
`Date`, and body before printing them. Email content is wholly
attacker-controlled — anyone can send you a message whose Subject or
body carries raw ANSI escape sequences — and Muse printed those bytes
straight to the terminal. A hostile sender could clear your screen,
move the cursor, recolour output, rewrite earlier lines, or set the
terminal title simply by you running `muse inbox`. Now the dangerous
bytes are removed at the render boundary; the visible text is kept.

The multi-line email body keeps its newlines and tabs
(`stripUntrustedTerminalChars` strips `\x00-\x08`, `\x0b-\x1f`,
`\x7f-\x9f` but preserves `\n` and `\t`), so a real plain-text email
stays readable while a `\x1b[2K` cursor command becomes inert literal
text. The `--json` path is unchanged — `JSON.stringify` already escapes
control bytes to `\uXXXX`, so machine consumers were never exposed.

## Why this, now

Every other untrusted-text surface in Muse already does this: feeds
(`formatFeedEntryLines`), web search (`sanitizeSearchField`), the
watch-folder inbox notice — and their comments literally cite "the
same boundary treatment the inbox / search surfaces apply." But the
inbox CLI itself was the gap: `formatInboxLine` / `formatEmailMessage`
interpolated the raw provider fields, and the Gmail provider parses
`From` / `Subject` / body straight from the API response with no
sanitization anywhere in the email path. Inbox triage is a core
daily-driver perception surface; an unauthenticated party (any sender)
controlling your terminal through it is a real, reachable defect, not a
hypothetical.

## How

Added `cleanInboxField(value)` =
`stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim()`
(strip + collapse to one line) and applied it to `From` / `Subject` /
`Date` in both `formatInboxLine` and `formatEmailMessage`. The body
uses `stripUntrustedTerminalChars(...).trim()` ONLY (no
whitespace-collapse) so its legitimate newlines survive. No provider
change, no new dependency (the strip helper is the shared
`@muse/shared` one the other surfaces use).

## Verification

`apps/cli` `commands-inbox.test.ts` (`npx vitest run --root apps/cli
commands-inbox.test.ts`, 17 passing): a hostile `From`/`Subject` with
`ESC[2J` / `ESC]0;pwned BEL` / `ESC[31m` → `formatInboxLine` output
carries no terminal-control byte yet still contains the visible sender
+ subject text; `formatEmailMessage` with ESC in every header AND the
body → no control byte in the output, the `From` text preserved, and
the body's legitimate `\n` between two lines retained; a clean message
renders byte-identically to before (no regression). Mutation-proven:
reverting `formatInboxLine` to interpolate the raw `From`/`Subject`
fails the listing injection test (ESC leaks); restored green.

`pnpm check` green across every workspace bar the unrelated known
voice-playback `/tmp` mkdtemp flake (inbox passes 17/17 in isolation;
build/tsc green for all packages). `pnpm lint` 0/0. Deterministic
terminal-output sanitization, no LLM path → no smoke:live (Ollama down
regardless).

## Decisions

- Sanitised at the CLI render boundary, not in the provider. The
  provider's `EmailMessage` is also consumed by the agent tool path and
  by `--json` (where raw-but-JSON-escaped is correct); stripping in the
  provider would mangle data for non-terminal consumers. The terminal
  is the only place raw control bytes are dangerous, so that's where
  the strip belongs — mirroring how feeds sanitises in
  `formatFeedEntryLines`, not in the store.
- Body keeps newlines (strip-only), headers collapse to one line
  (strip + whitespace-collapse) — a Subject with an embedded newline
  must not break the single-line listing, but a body's line structure
  is the content.
