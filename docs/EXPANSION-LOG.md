# Muse Expansion Log — the build journal

> Method (the user's directive, SpaceX-style): **run fast, varied checks; when
> something fails, record the failure and mine it for the next success.** Speed
> of iteration beats a slow perfect run. This file is the running record — what
> was tried, what shipped, what broke, and the lesson taken from each break.
>
> Pairs with [`EXPANSION-PLAYBOOK.md`](EXPANSION-PLAYBOOK.md) (the standing
> brief) and [`goals/CAPABILITIES.md`](goals/CAPABILITIES.md) (the loop's
> capability ledger). Verify fast with
> `node apps/cli/scripts/verify-tool-selection.mjs "<prompt>" <tool>` (one
> local-qwen round, ~1 min) instead of the slow full `pnpm smoke:live`.

## Shipped slices

| # | commit | capability | axis | proof |
|---|--------|------------|------|-------|
| 1 | `73eb9d4b` | proactive nudges due tasks in chat | proactive | unit + cli |
| 2 | `95ca95ab` | morning greeting by remembered name | memory×proactive | unit + cli |
| 3 | `5d6aaf41` | `/remember` shows visible supersede | memory | render |
| 4 | `b3e23a02` | `/forget` substring + ambiguity-safe | memory | unit + render |
| 5 | `b02033ef` | persistent ↑/↓ input history | CLI | unit + render |
| 6 | `37bb4032` | `/memory` surfaces episodic count | memory | unit |
| 7 | `8e111ebf` | `remember_fact` agent tool (NL memory) | memory · model-path | unit + **fast qwen3:8b selection** |

## Failures → learnings

- **Full `smoke:live` timed out (slice 7).** It picked `qwen3.6:35b-a3b` (a big
  MoE) and the run stalled at bootstrap, never reaching the cases. → **Lesson:**
  for a single tool-selection proof, a full smoke sweep is the wrong tool. Built
  `verify-tool-selection.mjs` — one round on `qwen3:8b`, ~1 min, exit 0/1.
  Reserve full `smoke:live` for broad regression sweeps.
- **Raw ESC byte from a heredoc (slices 5, prior).** Writing `"\x1B[A"` landed a
  literal 0x1b in source → repo byte-hygiene test failed. → **Lesson:** use
  `\uNNNN` / `String.fromCharCode`, never a raw control byte; the hygiene gate
  catches it, so run it after any test that embeds escape codes.
- **`JsonObject` imported from `@muse/tools` (slice 7).** Not exported there. →
  **Lesson:** JSON value types live in `@muse/shared`; mirror an existing tool's
  imports before writing a new one.
- **`/forget` table render-test broke (slice 4).** Adding substring resolution
  made `/forget city` resolve against the seeded snapshot; the old exact-key
  test assumed a key that wasn't there. → **Lesson:** when a command gains
  resolution logic, the render tests must seed the memory it resolves against.
- **Stale `dist/` test copies (earlier cleanup).** `tsc` doesn't delete outputs
  for removed sources; vitest then ran a stale dist test. → **Lesson:** `rm`
  orphaned `dist/*` after deleting a source file, then re-run.

## Open / next experiments

- Memory depth (2026 research, local-fit): reflection/synthesis recall, temporal
  validity on facts. Prototype small, verify fast.
- Performance: persona/context size as memory grows.
- CLI ergonomics + proactive smartness (not noisier).
