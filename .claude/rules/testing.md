# Testing & verification

Tests are the only form of verification. New behavior gets the
narrowest useful test first — direct unit test before integration
test before HTTP smoke.

This file is the **gate list** (which command proves what). For HOW to
test Muse as an *agent* — grade outcomes not paths, `pass^k`
reliability, tool-calling + irrelevance, multi-agent hand-off asserts,
binary LLM-judge — see [`agent-testing.md`](agent-testing.md) (the method).

## Verification gates (cheapest first)

1. **Single-package narrow check** while developing:
   ```bash
   pnpm --filter @muse/<name> test
   ```
2. **Full check** before commit:
   ```bash
   pnpm check                         # build + test for every workspace
   ```
3. **Diagnostic-provider HTTP smoke** (broad endpoint sweep, no API key):
   ```bash
   pnpm smoke:broad
   ```
4. **Live-LLM HTTP smoke** (real LLM round-trip):
   ```bash
   pnpm smoke:live
   ```
   **LOCAL OLLAMA ONLY by policy** — probes
   `${OLLAMA_BASE_URL:-http://localhost:11434}` and uses the local
   default model (gemma4:12b). Cloud APIs (GEMINI/ANTHROPIC/OPENAI) are
   never used; do not re-add them. Skips only if local Ollama is
   unreachable, and a skip is **not** a substitute for the round-trip —
   fixing the environment so it runs is itself priority work.
5. **Tool-selection reliability gate** (local one-shot tool choice):
   ```bash
   pnpm eval:tools
   ```
   A golden dataset (synthetic capabilities + Muse's REAL built-in
   tools + the confusable time-tool set) run straight against the
   local model and scored against a threshold (85% default). This is
   the lean, repeatable check for `tool-calling.md`'s first-class
   concern — the model picking the right tool in ONE shot — between
   static schema tests and the heavy `smoke:live`. **LOCAL OLLAMA
   ONLY**; skips (exit 0) when Ollama is unreachable. Run it after
   touching tool names/descriptions/schemas, the projection layer, or
   the Ollama adapter.
6. **Self-improving regression gate** (the 4 LLM live batteries as one):
   ```bash
   pnpm eval:self-improving
   ```
   Runs `verify-pattern-suggestion` (③), `verify-preference-inference`
   (②), `verify-skill-merge` + `verify-playbook-merge` (①) against the
   local Qwen in one pass and fails if ANY regresses — so the
   self-improving slices can't silently rot between individual battery
   runs. **LOCAL OLLAMA ONLY**; skips (exit 0) when Ollama is
   unreachable (a skip is not a pass). Run it after touching any of
   those LLM paths (pattern synthesis, preference inference, skill /
   playbook merge) or their prompts.
7. **Agent-eval gate** (the harness-based agent batteries as one):
   ```bash
   pnpm eval:agent
   ```
   Runs `eval:tools` (tool selection + ArgumentCorrectness),
   `eval:judge` (LLM-as-judge meta-eval), `eval:adversarial`
   (must-refuse safety + over-refusal controls), `eval:shadow-trial`
   (report-only promotion review), and `eval:plan-quality` (PlanQuality:
   valid/complete/ordered/efficient multi-step plans) in one pass and
   fails if ANY regresses — the agent-eval CI gate. All run on `scripts/eval-harness.mjs`
   (runEvalSuite + scorers + llmJudge + runShadowTrial). **LOCAL OLLAMA
   ONLY**; each battery skips (exit 0) when Ollama is unreachable. Run
   after touching tool names/descriptions/schemas, the eval harness, or
   any battery's cases.
8. **Grounded-vision gate** (image → grounded extraction → routed action):
   ```bash
   pnpm eval:vision
   ```
   Feeds checked-in document fixtures (`apps/cli/scripts/fixtures/vision/`:
   receipt / flyer / business card) to the multimodal default (gemma4) and
   asserts each routes to the right draft-first action with the key fields
   extracted (`muse ask --image --auto`). **LOCAL OLLAMA ONLY**; skips
   (exit 0) when Ollama is unreachable. Run after touching the vision
   extraction primitive, the `--auto`/`--extract` routing, or the Ollama
   image path.
9. **Lint gate**:
   ```bash
   pnpm lint
   ```
   ESLint flat config, all 11 rules at `error`. New violations
   block exit-0.

## Test placement

- Unit tests for policy, trimming, message pairing, capability logic.
- Contract tests per model provider adapter (mocked fetch).
- Integration tests for API run lifecycle and approval flows.
- CLI smoke tests for config, auth, local run, remote run.
- Playwright for UI flows.
- Testcontainers for PostgreSQL query behavior.
- Direct unit tests for every export of every helper module — no implicit-only coverage.

## Run only the narrowest test that proves THIS change (Jinan, 2026-06-22)

Running hundreds/thousands of tests "to be safe" is noise — it proves
nothing about the specific change and only saturates the machine. Run
the tests **directly related to the code you touched** and nothing more:

```bash
pnpm --filter @muse/<pkg> test -- <file>        # one file
pnpm --filter @muse/<pkg> test -- -t "<name>"   # one test by name
```

- Don't run a whole package suite, the whole repo, or `pnpm check` (full
  workspace build+test) for a small change. `pnpm check` is a pre-merge /
  human gate, NOT a per-edit step — autonomous loops especially must use
  narrow per-package filters, never `pnpm check`.
- Build only the package(s) you touched (`tsc -b` resolves stale upstream).
- The gate ladder above still applies, but pick the **single rung that
  exposes your change** — not every rung.

## Verify UI/web changes in a real browser (Jinan, 2026-06-22)

The macOS desktop app renders the bundled `apps/web` in a WKWebView, so a
web layout change *is* a desktop-app change. CSS layout bugs (scroll,
overflow, element sizing) do NOT show up in `vitest` — they only appear in
a real render. After any `apps/web` UI/layout change:

1. `pnpm --filter @muse/web build`, serve `dist` on a local port.
2. Drive it with the Playwright MCP (`mcp__plugin_playwright_playwright__*`)
   and **measure** — a headless browser is a sufficient proxy for the
   WKWebView (WebKit) render.
3. Assert numbers, not vibes: the changed view's `.content` is bounded to
   the viewport and `scrollTop > 0` after a tall probe; no container
   overgrows the viewport; icons/images render at their intended size.

Recurring scroll/blowout regression classes to check first: missing
`html, body { height: 100% }` (breaks the `%`-height chain), a grid row
left at `auto` instead of `minmax(0, 1fr)`, a flex child without
`min-height: 0`, and viewBox-only SVGs with no intrinsic/CSS size (fall
back to ~300×150 and blow up the layout).

## Anti-patterns

- Don't replace a real test with a comment.
- Don't disable a failing test to ship.
- Don't skip the verification gate above the cheapest one that exposes the change you made.
- Don't claim "tested" when the only thing that ran was `tsc`.
- Don't accept fall-back assertions on tool-using flows — assert the tool was actually called.
- Don't run the full suite / `pnpm check` for a small change; run the narrowest related test.
- Don't claim a UI/layout fix works without a real-browser measurement.
