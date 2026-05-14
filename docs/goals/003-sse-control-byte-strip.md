# 003 — SSE stream control-byte strip

## Why

The CLI's SSE consumer streams server-emitted text straight to stdout
(`io.stdout(event.data)` in `streamRemoteChat`). The API server's
response paths are trusted, but `event.data` ultimately carries
model output + tool result text — both untrusted by the CLAUDE.md
rule. A control-byte payload (ANSI, BEL, NUL) from a tool result
would land verbatim on the user's terminal.

## Scope

- Reuse `stripUntrustedTerminalChars` (already exported from
  `commands-search.ts` after 7b40b0f) — lift to a shared cli-side
  helper module if cleaner.
- Apply to `event.data` before `io.stdout(event.data)` in
  `streamRemoteChat`.
- Direct unit test on a synthetic SSE frame with `\x1b[2J`.

## Verify

- pnpm check / lint / smoke broad+live.
- New test asserts ANSI sequences in SSE `data:` lines don't make
  it to stdout.

## Status

open
