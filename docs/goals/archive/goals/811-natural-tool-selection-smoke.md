# 811 — test: natural one-shot tool-selection smoke:live scenario + 10-iter regression sweep

## Why

The human's #1 priority is that the LOCAL model picks the RIGHT tool in
ONE shot from a NATURAL request — not only when explicitly told which
tool to call. `smoke:live` already had a "strict tool-call loop"
scenario, but its prompt is "You MUST call the time_now tool …" — that
proves the model CAN call a named tool, NOT that it SELECTS the right
one unprompted. That natural-selection check was the missing
verification for the whole tool-calling-reliability effort (799–810).
Also the 10th iteration since the 801 sweep → regression sweep due.

## Slice

`scripts/smoke-live-llm.mjs` — add a "NATURAL one-shot tool selection"
scenario: a bare "What day of the week is it right now in Seoul?" (no
"call X" instruction) must drive the model to select `time_now` on its
own and answer with a weekday. The assertion message frames a failure
as the exact one-shot-selection defect to fix (tighten the tool
description / shrink the exposed set), not a harness bug.

## Verify

- `node --check scripts/smoke-live-llm.mjs` — syntax OK; `pnpm
  smoke:live` exits 0 with a clean skip (Ollama unreachable on the loop
  PC), proving the new scenario doesn't break the harness.
- **10-iter regression sweep (802–810)**: full `pnpm check` EXIT 0
  across every workspace suite, `pnpm lint` 0/0, `pnpm smoke:broad`
  51/0. No regression found.
- **`[UNVERIFIED-LIVE]`** — the natural-selection round-trip itself
  cannot run until local Ollama (Qwen) is reachable; it is added
  harness, NOT a delivered+verified capability, so it does NOT get a
  CAPABILITIES line / bullet flip. When Ollama returns it runs
  automatically; a failure then is a real tool-calling defect to fix.

## Decisions

- **Added, not claimed** — per "a capability you cannot exercise
  end-to-end is not done", this is recorded as the verification machine
  for natural one-shot selection, tagged `[UNVERIFIED-LIVE]`, not as a
  shipped capability. It's the honest next step for the human's
  priority while Ollama is down (the recurring blocker across 799–810).
- No source/runtime change — `test:`-only (smoke harness) + the
  mandated periodic sweep.
