# 684 — `muse show` rejects a 0-byte file with a clear error instead of emitting an empty iTerm2 inline-image sequence (a silent no-op on iTerm/WezTerm/Ghostty) or having the OS viewer "open" an empty file

## Why

`muse show <path>` (goal 096) renders an image inline via the iTerm2
OSC-1337 protocol. `readFile` succeeds on a **0-byte** file (a
truncated or failed download, an empty placeholder), so the command
fell straight through to one of:

- inline path → `buildIterm2InlineImageSequence` emits
  `…File=inline=1;name=<b64>:` with an **empty** base64 payload — a
  silent no-op on iTerm2 / WezTerm / Ghostty (nothing renders, no
  error), or
- fallback path → the OS viewer (`open` / `xdg-open`) is handed a
  0-byte file and the user is told "(opened … via the system viewer)".

Either way the user gets no actionable signal that the file is empty.

### Scope / why this iteration is not P10

P10 (tiered orchestration) has been the last three feat slices
(681/682/683 — the multi-agent / tiering area). The remaining P10 piece
(`muse orchestrate --tiered`) needs a per-spec `tier` field on
`AgentSpec` (a cross-package schema change) plus a live two-tier
round-trip, which is large. Per the iteration-loop stagnation guard
("one area churned ⇒ target a different bullet"), this iteration is a
fresh-area, user-facing polish (the standing prompt blesses
"edge cases / robustness / UX" equally). P10's orchestrate half resumes
next.

(Two candidate observability finite-guards were investigated and
**rejected as inward churn**: `aggregateStats(windowMs)` and the
`InMemoryFollowupSuggestionStore` constructor both lack a non-finite
guard, but the only production callers pass the default window and
`autoconfigure`'s `parseInteger` already rejects NaN/Infinity — so
neither bug is reachable. Guarding them would be defensive code with no
observed failure.)

## Slice

- `apps/cli/src/commands-show.ts`: after the `readFile` succeeds, if
  `imageBytes.length === 0`, write
  `muse show: <path> is empty (0 bytes) — nothing to render.` to stderr,
  set `process.exitCode = 1`, and return — before the inline / fallback
  branches. One WHY comment names the empty-payload no-op.
- `apps/cli/test/program.test.ts`: a surface-level integration test that
  writes a real 0-byte file, sets `TERM_PROGRAM=iTerm.app` (so the
  inline path would otherwise fire), drives the real `muse show`
  command, and asserts the error message is shown, NO OSC-1337 sequence
  was emitted, and `exitCode === 1`.

## Verify

- `pnpm --filter @muse/cli test`: 1157 passed (1 new).
- **Clean-mutation-proven**: removing the guard makes the new test fail
  — the empty file emits `…1337;File=inline=1;name=ZW1wdHkucG5n:` (empty
  payload) and the assertions on the error message + absent sequence
  fail. Restored; all green.
- `pnpm check`: EXIT=0 — every workspace builds + tests green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm check:capabilities`: ✓ every cited test/script file exists.
- Byte-hygiene scan on the two touched files: clean.
- No request/response wire path touched — `muse show` is a local
  file-read + terminal-write; `smoke:live` / `smoke:broad` do not apply.

## Status

Done.

| `muse show` input        | before                                   | after                          |
| ------------------------ | ---------------------------------------- | ------------------------------ |
| missing file             | "could not read …" + exit 1              | unchanged                      |
| 0-byte file (iTerm)      | empty inline sequence (silent no-op)     | "is empty (0 bytes)" + exit 1  |
| 0-byte file (other term) | OS viewer "opens" an empty file          | "is empty (0 bytes)" + exit 1  |
| real image               | inline render / OS viewer                | unchanged                      |

## Decisions

- **Guard after the read, before both branches** — covers the inline
  AND the fallback path with one check; an empty file is never a valid
  render input regardless of terminal.
- **Exit 1, not a warning** — an empty image is a failed operation, so
  the command should signal failure to a script/pipeline, consistent
  with the existing unreadable-file path.
- **No magic-byte / format validation added** — that is a larger,
  separate concern (and terminals tolerate many formats); this slice
  fixes only the unambiguous empty-file case.

## Remaining risks

- **A non-empty but non-image file** (e.g. a text file) is still passed
  through to the terminal / OS viewer — terminals simply ignore an
  unrecognised inline payload and the OS viewer reports its own error,
  so this is lower-severity than the silent empty-file no-op and is left
  out of scope.
