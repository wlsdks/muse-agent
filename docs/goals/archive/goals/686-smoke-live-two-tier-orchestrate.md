# 686 — P10 s5 (two-tier live): a `smoke:live` round-trip proves that in ONE `muse orchestrate --tiered` run against a real server + real Ollama, the two workers provably executed on two DISTINCT local Qwen tiers with real output

## Why

P10 s1–s4 built the tiering machinery (per-worker model dispatch, the
classifier + planner, the `muse ask` and `muse orchestrate --tiered`
surfaces) and proved each piece with integration / `smoke:broad`
(diagnostic) checks. The one thing NO automated check had yet shown is
the actual JARVIS payoff: a *real* run where a fast model takes one
worker and a high-capability model takes another — on the loop PC's
local Ollama, end-to-end.

This iteration adds that `smoke:live` check. The loop PC has two local
Qwen tiers (`qwen3:8b`, `qwen3.6:35b-a3b`), so the round-trip is real
and zero-cost.

## Slice

- `scripts/smoke-live-llm.mjs`:
  - `pickTierModels(fastModel)` — queries Ollama `/api/tags`, reuses the
    already-picked (warm) provider model as `fast`, and selects any
    OTHER local qwen as `heavy`. Returns `undefined` (→ the tiered check
    is skipped, not failed) when fewer than two distinct qwen models
    exist.
  - When two tiers exist, the spawned API server's env gains
    `MUSE_FAST_MODEL` / `MUSE_HEAVY_MODEL`.
  - New live check **"POST /api/multi-agent/orchestrate --tiered (live)
    — two workers run on two distinct local Qwen tiers"**: seeds a
    lookup-role spec (`"Look up facts…"` → fast tier) and an
    analyze-role spec (`"Analyze the trade-offs…"` → heavy tier), POSTs
    `{ tiered: true, mode: "parallel", workerIds }`, and asserts both
    completed, each result carries a non-empty `model`, the two
    `model` values DIFFER (the core P10 payoff: two tiers in one run),
    and each produced real output.

## Verify

- `pnpm smoke:live` (with `OLLAMA_BASE_URL=http://127.0.0.1:11434
  MUSE_SMOKE_LIVE_MODEL=qwen3:8b GEMINI_API_KEY=""`):
  - `smoke:live — tiered orchestrate enabled: fast=ollama/qwen3:8b
    heavy=ollama/qwen3.6:35b-a3b`
  - **PASS** "POST /api/multi-agent/orchestrate --tiered (live) — two
    workers run on two distinct local Qwen tiers" — the lookup worker
    ran on `qwen3:8b`, the analyst on `qwen3.6:35b-a3b`, distinct, with
    real output.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- Byte-hygiene scan on the touched script: clean.

### Pre-existing unrelated failure (NOT introduced here)

The same `smoke:live` suite reports one FAIL — "POST /api/chat —
native web_search returns citations" — because local Ollama `qwen3:8b`
has no native web_search (a cloud-provider feature); the model replied
that it lacks live web access. This is orthogonal to tiering (a plain
`/api/chat` call on `MUSE_MODEL`, untouched by the tier env) and is an
inherent local-Ollama-only limitation, not a regression from this
change. A candidate future fix is to make that check skip gracefully
when the active provider advertises no native web_search (the same
"skip, don't fail" stance the tiered check uses for <2 models).

## Status

P10 s5 two-tier-live: delivered. The s4+s5 parent bullet is now SPLIT
into four children (ask 683, orchestrate 685, two-tier-live 686 — all
`[x]`); the parent stays `[ ]` pending the final child: wiring
`planTieredRun`'s capacity probe into the orchestrate server so a
low-capacity host collapses to single-heavy, with a check proving the
live collapse.

## Decisions

- **Assert model-DISTINCTNESS, not exact model strings** — a real
  Ollama run reports its own model id (format may differ from the
  `ollama/…` request string), so the robust, intent-faithful assertion
  is "the two workers ran on two different models in one run" plus real
  output. That is exactly the bullet's "two distinct local Qwen tiers".
- **`fast` = the warm provider model** — reusing the already-loaded
  model for the fast tier avoids loading a third model; only the heavy
  tier loads fresh.
- **Skip (not fail) when <2 qwen models** — mirrors `smoke:live`'s
  existing skip-when-unreachable stance; the check is a no-op on a
  single-model host rather than a false failure.
- **Bullet split, parent stays `[ ]`** — the OUTWARD-TARGETS preamble
  permits splitting; s4+s5 is genuinely four deliverables, so marking
  the three met children `[x]` (each with a green check) while the
  parent + capacity-collapse child stay `[ ]` is the honest ledger.

## Remaining risks

- **Live low-capacity collapse not yet wired** — the orchestrate server
  assigns tiers but does not call `planTieredRun`'s capacity probe, so a
  host that cannot hold both tiers does not yet collapse to
  single-heavy on the live surface. That is the final s4+s5 child.
- **The heavy tier loads on first call** — `qwen3.6:35b-a3b` (MoE, ~3B
  active) loads fresh for the tiered check, adding latency; acceptable
  for a smoke round-trip and skipped entirely on single-model hosts.
