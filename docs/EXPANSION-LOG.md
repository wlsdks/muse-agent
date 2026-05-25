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
| 8 | `7afb8135` | fast tool-selection verifier + build journal | tooling | self-test PASS |
| 9 | `2506d4a0` | background auto-memory (learn facts without "remember") | memory · model-path | unit + **fast qwen3:8b extraction** |
| 10 | `37a84e61` | show auto-learned facts in chat (trust + undo) | memory · CLI | unit + render |

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
- **Auto-extract returned EMPTY on qwen3:8b (slice 9).** The shared
  `pickAutoExtractSystemPrompt` produced valid-but-empty JSON for clear facts
  ("I live in Busan and prefer short answers") — the model was too conservative,
  and the earlier hook success was partly luck. The JSON parser was fine. →
  **Lesson:** the small local model needs a SHARPER, example-bearing
  output-only-JSON prompt. A 4-case fast check (Busan+short / name+job /
  vegetarian / "2+2?"→empty) then extracted reliably. Shipped that prompt in
  chat-auto-memory.ts. Confirms the iterate-fast method: the live MISS, not the
  unit test, found the real gap.
- **Auto-memory stored a fact from a QUESTION (slice 11 diverse battery).**
  "What's the weather in Busan?" → wrongly stored `home_city: Busan`. The 9-case
  EN/KO + negatives battery caught it; the happy-path checks didn't. → **Lesson:**
  add explicit negatives to the prompt ("only DECLARATIVE self-statements; do
  NOT infer from questions/requests" + a weather + a task example). Re-ran → 9/9.

## Reusable patterns (carry these forward)

- **Small-model structured extraction:** OUTPUT-ONLY-JSON + concrete examples +
  explicit NEGATIVE examples. qwen3:8b then complies in one shot; vague prompts
  return empty or over-extract. (chat-auto-memory `CHAT_AUTO_EXTRACT_SYSTEM`.)
- **Fast > exhaustive for a single proof:** one local-qwen3:8b round (~1 min)
  beats a full `smoke:live` sweep (the 35b sweep stalled). Build a tiny
  parameterized verifier per concern (`verify-tool-selection.mjs`,
  `verify-auto-memory.mjs`); include EN+KO and negatives. Reserve full
  `smoke:live` for broad regression.
- **Live diverse checks catch what unit tests miss:** unit tests (fake provider)
  passed while the real model over-extracted. A model-path change needs a
  real-model battery, not just unit coverage.
- **Interactive UI is verifiable:** drive `useInput → submit → frame` with
  ink-testing-library (`chat-ink-render.test.ts`) — no PTY needed.
- **Keep model-heavy side effects OFF the reply path:** the runtime's
  afterComplete hook is awaited (blocks). For chat, run extraction in the
  background, cooldown-gated, so the streamed reply stays snappy.
- **Surface autonomous actions for trust:** when the agent learns/acts on its
  own, show it + offer one-tap undo ("📝 remembered: … /forget <key>").

## Open / next experiments

- Memory depth (2026 research, local-fit): reflection/synthesis recall, temporal
  validity on facts. Prototype small, verify fast.
- Performance: persona/context size as memory grows.
- CLI ergonomics + proactive smartness (not noisier).
