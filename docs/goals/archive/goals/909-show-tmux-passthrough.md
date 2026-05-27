# Goal 909 — `muse show` renders inside tmux (OSC-1337 passthrough)

## Outward change

`muse show <image>` now renders inline when run inside a tmux session
on an inline-capable terminal (iTerm2 / WezTerm / Ghostty). Before, the
raw iTerm2 OSC-1337 inline-image sequence was intercepted and silently
discarded by tmux, so a user multiplexing their terminal (very common
among CLI users) got nothing — no image, no error. Now the sequence is
wrapped in the tmux passthrough envelope so tmux forwards it verbatim
to the outer terminal.

## Why this, now

tmux commonly forwards `TERM_PROGRAM=iTerm.app` into its panes, so
`detectInlineImageSupport` returns true inside tmux and the command
takes the inline path — emitting bytes tmux eats. The result is a
broken `muse show` for the large slice of users who live in tmux, with
no fallback (the OS-viewer path is skipped because we "have" inline
support). A render command that produces nothing inside the most
common terminal-multiplexer setup is a real daily-driver defect, not
an edge case.

## How

New pure `wrapForTmux(sequence, inTmux)`:
- outside tmux → returns the sequence byte-for-byte unchanged;
- inside tmux → wraps it as `ESC P tmux ; <payload> ESC \` with every
  inner `ESC` doubled (the documented tmux passthrough format), so
  tmux forwards the OSC-1337 bytes to the outer terminal verbatim.

The `muse show` action wraps the built sequence with
`wrapForTmux(seq, Boolean(process.env.TMUX))` before writing it. tmux's
`allow-passthrough` is on by default in tmux ≥ 3.5; on older tmux the
user enables it once — either way emitting the passthrough is strictly
correct (without it nothing renders regardless).

## Verification

`apps/cli` `program.test.ts` (`npx vitest run --root apps/cli
test/program.test.ts -t "wrapForTmux"`): outside tmux → identical
bytes; inside tmux → starts with `ESC P tmux ;`, ends with `ESC \`,
inner ESCs doubled (`ESC ESC ]1337`), and unwrapping (strip envelope +
halve the ESCs) recovers the original sequence exactly. Mutation-proven:
dropping the ESC-doubling fails the unwrap/round-trip assertion;
restored green. The existing inline-image + 0-byte tests stay green
(`-t "inline"` → 4 pass). `pnpm check` green (apps/cli 1625, apps/api
323); `pnpm lint` 0/0. Pure byte transform, no LLM path → no smoke:live
(Ollama down regardless).

## Decisions

- Gated on `process.env.TMUX` (tmux's own presence signal) rather than
  parsing `TERM` for `screen`/`tmux`: `TMUX` is set iff a real tmux
  server owns the pane, which is exactly when the passthrough is
  needed. GNU `screen`'s different (rarer) passthrough is left for a
  later slice rather than guessed at here.
- Kept `wrapForTmux` a separate pure function from
  `buildIterm2InlineImageSequence` so the protocol bytes and the
  multiplexer envelope stay independently testable and composable.
