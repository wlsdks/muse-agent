# Goal 881 — voice playback surfaces the player's stderr on failure

## Outward change

When `muse today --speak` / `muse listen` / proactive `--speak`
plays audio and the system player (`afplay` / `aplay`) fails, the
error now includes the player's own stderr — e.g. `aplay exited
with code 1: ALSA lib: ... No such device` instead of the bare
`aplay exited with code 1`. A user whose audio output is
misconfigured can now see *why* from the message alone.

## Why this, now

`playAudioWithWatchdog` spawned the player with
`stdio: ["ignore", "ignore", "pipe"]` — opening stderr as a pipe —
but never read it. Two real consequences:

1. The captured failure reason was silently discarded; playback
   failures were undebuggable from the surfaced error.
2. An unconsumed pipe can wedge a chatty player once its OS buffer
   (~64 KB) fills — the very hang the watchdog exists to prevent,
   reachable on a different path.

Voice is a fresh, not-recently-swept surface; this is the smallest
real correctness/UX gap on it (and avoids the known full-suite
playback flake — the change is to the watchdog, tested in isolation).

## How

`playAudioWithWatchdog` now attaches a `data` listener to
`child.stderr` (guarded for the ignored-stdio case), accumulating up
to 4 KB. On a non-zero exit the captured text is sanitised
(`stripUntrustedTerminalChars` — a player's stderr is untrusted
output that could carry ESC bytes) and truncated
(`truncateErrorBody`, 240) before being appended to the rejection
message. Zero-exit, spawn-error, and timeout paths are unchanged.

## Verification

`apps/cli` `voice-playback.test.ts`: the fake child gained a
`stderr` EventEmitter; a new test emits `ALSA lib: \x1b[31mNo such
device\x1b[0m` then `close 1` and asserts the rejection contains
`aplay exited with code 1: ALSA lib: [31mNo such device` AND does
NOT contain the raw ESC byte (proves sanitisation). Existing
non-zero / zero / spawn-error / timeout / double-settle cases stay
green (the empty-stderr case still matches the bare-code message —
backward compatible). Mutation-proven: dropping the stderr-detail
append fails the new test. No LLM path → no smoke:live; Ollama down
regardless. `pnpm check` exit 0, `pnpm lint` 0/0.

## Decisions

- Bounded the capture at 4 KB — enough for a real player's
  diagnostic line, capped so a pathological player can't grow it
  without limit.
- Reused the canonical `@muse/shared` sanitiser/truncator rather
  than ad-hoc slicing — same treatment every other untrusted-text
  surface gets.
