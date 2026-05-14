# 096 — `muse show <image>` — inline terminal image render

## Why

JARVIS HUDs Tony's diagnostics into his field of view. Muse can
describe images (goal 087) but never displays them — the user
sees text only. Add `muse show <image>` that emits the iTerm2
inline-image protocol escape sequence (also honored by Kitty,
WezTerm, mintty). Pure ANSI bytes, no dep. Falls back to
`open <path>` (macOS) or `xdg-open` (Linux) when the terminal
doesn't advertise inline-image support.

## Scope

- New `apps/cli/src/commands-show.ts` with
  `muse show <path> [--name <label>] [--inline-only]`.
- Detect inline support: `process.env.TERM_PROGRAM` ∈
  `{ "iTerm.app", "WezTerm", "tabby" }` OR
  `process.env.TERM` startsWith `"xterm-kitty"`.
- Inline path: read the file, base64-encode, emit
  `\x1b]1337;File=inline=1;name=<b64>:<imageb64>\x07`.
- Non-inline fallback (unless `--inline-only`):
  spawn `open` on macOS, `xdg-open` on Linux.
- `--inline-only` skips the fallback so a piped consumer (`muse
  show … | tee`) gets predictable bytes.

## Verify

- cli +1 unit test on the escape-sequence builder: given a known
  byte buffer + name, asserts the prefix / suffix wrap around the
  expected base64 length.
- Dogfood:
  ```
  # Same tiny PNG used in goal 087.
  node -e "const f=require('fs'); f.writeFileSync('/tmp/muse-show-test.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f80f000001010001b4070ffe0000000049454e44ae426082','hex'))"
  node apps/cli/dist/index.js show /tmp/muse-show-test.png --inline-only | od -c | head -3
  ```
  Pass if `od` output contains the iTerm2 `1337;File=inline=1`
  escape sequence prefix.

## Status

done — `apps/cli/src/commands-show.ts` registers `muse show <path>`
with the iTerm2 inline-image escape sequence
(`ESC ] 1337 ; File = inline=1 ; name=<b64-name> : <b64-image> BEL`).
`detectInlineImageSupport(env)` returns true for `TERM_PROGRAM` ∈
`{ iTerm.app, WezTerm, tabby }` or `TERM` starting with `xterm-kitty`;
all other terminals fall through to `open` / `xdg-open` unless
`--inline-only` forces the byte stream. Both helpers are pure +
exported so the unit test in `apps/cli/test/program.test.ts` pins
the shape (header bytes, `BEL` terminator, base64 round-trip of
name + image) without writing to stdout or spawning child
processes. Dogfood passed on a hand-rolled 1×1 PNG: `od -c` of the
output starts with `033 ] 1 3 3 7 ; F i l e = i n l i n e = 1`,
matching the pass criterion. `pnpm check` + `pnpm lint` 0/0 +
`pnpm smoke:broad` 51/51 + `pnpm smoke:live` 13/13 all green.
