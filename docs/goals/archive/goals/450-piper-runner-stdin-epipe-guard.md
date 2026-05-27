# 450 — Piper runner survives a child that closes stdin early (EPIPE crash guard)

## Why

`createPiperRunner` (`@muse/voice` `piper.ts`) is the spawn runner
behind `PiperTtsProvider` — the **operative local TTS path**
under the Qwen-only / zero-cost mandate (the way JARVIS talks
back, free + offline). It pipes the synthesis text to the piper
binary's stdin:

```ts
child.stdin?.write(stdin);
child.stdin?.end();
```

There was **no `error` listener on `child.stdin`**. If the piper
process exits before consuming stdin — a bad/missing `.onnx`
model, a binary/version mismatch, an immediate crash — the write
hits a closed pipe and the stdin stream emits `'error'` (EPIPE).
An unhandled `'error'` on a Node stream is escalated to
`uncaughtException`: it **crashes the whole Muse process**
instead of the intended graceful `SPAWN_FAILED` / `EXIT_n`
rejection the docstring promises ("fails fast instead of hanging
forever" — but an early-exiting child *crashed*, it didn't fail
fast cleanly). `child.on("error", …)` only catches spawn-level
errors (ENOENT); the stdin EPIPE is emitted on a different
emitter (`child.stdin`) and was unhandled.

The existing fast-exit test passes only because it writes a
2-byte stdin that fits the pipe buffer before the child is gone —
so the EPIPE path was **genuinely uncovered**. This is a concrete
process-crash-class safety bug on a core JARVIS modality
(voice output), the classic Node child-stdin footgun; fresh
package (voice last touched goal 432, ~19 iterations ago); a
real `fix:` that also closes a coverage gap.

## Slice

- `packages/voice/src/piper.ts` — attach
  `child.stdin?.on("error", () => undefined)` before the
  write/end. The child's exit code / the timeout are already the
  authoritative outcome (the `close` handler resolves/rejects on
  them); an stdin-write failure just means the child didn't
  consume our input, which the exit code already reflects — so
  the EPIPE is absorbed instead of crashing the process. The
  canonical, minimal fix for this footgun; no behaviour change
  for any child that *does* read stdin.
- `packages/voice/test/voice.test.ts` — a new `it` beside the
  existing `createPiperRunner` tests: a child that
  `process.stdin.destroy()`s then exits 3 after a tick, fed a
  2 MB stdin that cannot drain into the closed pipe → forces
  EPIPE deterministically; asserts the runner still resolves with
  `exitCode: 3` (the close handler reports the real outcome) and
  no unhandled stream error escapes.

## Verify

- New `it` green; full `@muse/voice` suite 69 passed (1 file, +1
  it) with **no Unhandled Errors**; tsc strict (voice) EXIT=0.
- **Mutation-proven teeth**: removing the
  `child.stdin?.on("error", …)` listener makes the run report
  `⎯ Unhandled Errors ⎯ Error: write EPIPE { code: 'EPIPE' }`
  attributed to exactly the new test (the process-crash bug
  reproduced); `stdin?.on("error"` occurrence count went 1→0
  then restored to 1, suite back to clean green.
- `pnpm check` EXIT=0, every workspace green (voice 69, cli 739,
  api …) — no regression; `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean; `git status` shows only the two
  intended files.
- Deterministic child-process handling for a local TTS binary —
  not a model / LLM request-response wire path; `smoke:live`
  does not apply (per `testing.md` / iteration-loop Step 9).

## Status

Done. A misconfigured or crashing local Piper voice (wrong model
path, version mismatch, immediate exit) now fails as a clean
`SPAWN_FAILED` / `EXIT_n` rejection the caller can handle, instead
of an unhandled EPIPE that takes down the whole Muse process.
Voice synthesis for any healthy child is unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a process-safety `fix:` to an existing
local-voice feature, recorded honestly with this backlog row —
not a false metric.

## Decisions

- Bare absorbing `() => undefined` listener, not a reject path:
  the `close` and timeout handlers are the single source of truth
  for resolve/reject (exit code / SIGKILL); routing the stdin
  EPIPE to its own reject would race them and could mask the real
  exit-code outcome. Absorbing is the canonical fix — the error
  is a *symptom* of the child being gone, not the diagnosis.
- Forced EPIPE with a 2 MB stdin + `process.stdin.destroy()`
  rather than a tiny string: a small write buffers and never
  EPIPEs (exactly why the pre-existing fast-exit test missed
  this), so the regression must overflow the 64 KB pipe into a
  destroyed read end to be deterministic.
- Left the borderline `format !== "wav"` case-normalization
  (432 sibling: `"WAV"` / `" wav"` over-strictly rejected)
  alone: real but lower-leverage and not probe-demonstrated as a
  live failure; the EPIPE crash is the concrete, high-blast
  defect this iteration. Noted, not chased.
