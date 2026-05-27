# 689 — `smoke:live` skips the native-web_search check on local Ollama instead of failing it, so the suite returns exit-0 on the loop PC and the regression sweep can trust a clean run

## Why

`smoke:live` is **local-Ollama-only by policy**. The check "POST
/api/chat — native web_search returns citations" exercises a
*cloud-provider* capability (Gemini/OpenAI/Anthropic grounding tools);
local Ollama qwen has no native web_search, so the check could never
pass under the mandated environment. It therefore FAILED on every loop
run (observed in goal 686: `13 passed, 1 failed`), making
`pnpm smoke:live` exit 1 permanently.

A permanently-red `smoke:live` is corrosive to the loop's own honesty
machinery: the iteration-loop contract runs a regression sweep
("re-run ALL `CAPABILITIES.md` checks; any regression ⇒ next iteration
restores it"). A standing failure means a NEW regression hides behind
the known one — "1 failed" stops being a signal. Restoring a clean
exit-0 makes the sweep trustworthy again.

This is not weakening a check: the check is *inapplicable* to the
local-only environment (the same reason `smoke:live` already skips
entirely when Ollama is unreachable, and the tiered check skips when
<2 qwen models exist). It now skips with a visible reason rather than
asserting a capability the environment cannot have.

## Slice

- `scripts/smoke-live-llm.mjs`:
  - `class SmokeSkip` + `skip(reason)` — a check throws it to mark
    itself not-applicable. `record` catches `SmokeSkip` → status
    `"skip"` (NOT a failure, NOT a misleading pass).
  - The web_search check skips when the active provider is not a
    web-search-capable cloud provider (`anthropic`/`gemini`/`openai`)
    — i.e. always, under the local-Ollama-only policy.
  - The summary prints `SKIP  <name>: <reason>` and the tally line
    gains `, N skipped`.

## Verify

- `pnpm smoke:live` (`OLLAMA_BASE_URL=http://127.0.0.1:11434
  MUSE_SMOKE_LIVE_MODEL=qwen3:8b GEMINI_API_KEY=""`):
  **`13 passed, 0 failed, 1 skipped`** — the web_search check now
  reads `SKIP  … native web_search requires a cloud provider;
  smoke:live is local-Ollama-only (provider=ollama)`, and the suite
  exits 0. Every other live check (incl. the goal-686 two-tier
  orchestrate round-trip) still PASSes.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- Byte-hygiene scan on the touched script: clean.

## Status

Done. `smoke:live` is exit-0 on the loop PC; the regression sweep's
"any FAIL ⇒ restore" rule is meaningful again.

## Decisions

- **Skip, not delete** — the check stays in the suite and would run
  (strictly) on a cloud provider; it only skips where the capability
  is structurally absent. Deleting it would lose the cloud-path
  coverage that `smoke-live-all-providers.mjs` / future cloud runs
  rely on.
- **Skip ≠ pass** — a distinct `SKIP` status (not a silent `return`
  soft-pass like the pre-existing Gemini branch) keeps the output
  honest: the reader sees the capability was not exercised, not that
  it passed.
- **Provider allowlist for web_search** — `anthropic`/`gemini`/`openai`
  are the providers with native grounding tools; anything else
  (ollama/lmstudio/local/diagnostic) skips. Matches the cloud-only
  nature of the capability.

## Remaining risks

- **The Gemini soft-pass branch remains a `return`** (counts as PASS,
  not SKIP) — left as-is to keep this change minimal; a future cleanup
  could route it through `skip` for consistency when Gemini returns no
  citations.
- **No new outward capability** — this is verification-integrity work,
  so it adds no `CAPABILITIES.md` line and flips no target bullet; its
  value is restoring a trustworthy regression signal.
