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
   Runs every battery in the `CAPABILITY_MATRIX` registry of
   `scripts/eval-agent.mjs` in one pass and fails if ANY required one
   regresses. **That registry is the authority — read it rather than a
   copy here**, because a hand-maintained list drifts (it did: this gate
   named `eval:judge` and `eval:shadow-trial`, which `eval-agent.mjs`
   never calls, and omitted six batteries it does). **LOCAL OLLAMA ONLY**;
   each battery skips (exit 0) when Ollama is unreachable. Run after
   touching tool names/descriptions/schemas, the eval harness, or any
   battery's cases.
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
   ESLint flat config; every rule it sets is at `error`
   ([code-style](../engineering/code-style.md) owns the rule list).
   New violations block exit-0.

## `MUSE_REQUIRE_LIVE=1` — a skip is not a pass

Live batteries exit 0 when Ollama or Chrome is missing, and print the reason. An unattended
fire reads the aggregate, not the prose, so a box with no model made every live gate green.
Set `MUSE_REQUIRE_LIVE=1` in any autonomous context: `pnpm eval:agent` then FAILS the
capability instead of recording it `unverified`, and `pnpm eval:self-improving` classifies
the battery as a failure. Off by default so an interactive run on a laptop without Ollama
still works.

`eval-skip.mjs` also exports `skipExitCode` (0 normally, 75 = `EX_TEMPFAIL` under the flag)
for a battery that wants to signal a skip through its own exit code. **No battery calls it
yet** — the aggregates above are where the flag currently bites.

## Test placement

- Unit tests for policy, trimming, message pairing, capability logic.
- Contract tests per model provider adapter (mocked fetch).
- Integration tests for API run lifecycle and approval flows.
- CLI smoke tests for config, auth, local run, remote run.
- Playwright for UI flows.
- Testcontainers for PostgreSQL query behavior.
- Direct unit tests for every export of every helper module — no implicit-only coverage.
- Factual agent evidence and user judgments are separate test dimensions. For
  Continuity, prove exact source/event binding and unchanged bytes on rejected
  or replayed interaction receipts; never assert that task completion implies
  `used`, feedback coverage, permission, or promotion.

## Which runner

- **Vitest** is the TypeScript runner. `node:test` is only for dependency-free
  `scripts/*.mjs`.
- **`*.browser.test.tsx`** (Vitest Browser Mode + Playwright) for React focus,
  keyboard, hooks and DOM events; static markup contracts stay in fast Node tests.
- Everything else about the stack — when property-based testing is warranted, when
  MSW earns its place over an injected fetch fake, and why the `forks` pool and
  worker count are not to be changed without an A/B — is decided in
  [`testing-strategy.md`](../../../docs/development/testing-strategy.md), which owns
  the measurements. Do not restate its numbers here; they drifted once already.

## Run only the narrowest test that proves THIS change (Jinan, 2026-06-22)

Running hundreds/thousands of tests "to be safe" is noise — Muse has
**thousands of `*.test.ts(x)` files across `packages/` + `apps/`** (`pnpm self-eval`
prints the live count; do not hand-copy a number here — three different
counts of it have already disagreed). The count is healthy; running ALL of
it per edit is the waste. A full package suite per edit proves nothing
about the specific change and only saturates the machine. Run the tests
**vitest decides are RELATED to the files you changed** and nothing more:

```bash
pnpm test:changed                 # ★ DEFAULT per-edit gate: git-changed files → vitest related (the tests whose module graph touches them), per affected package
pnpm test:changed --uncommitted   # tighter inner loop: uncommitted changes only
pnpm --filter @muse/<pkg> test -- <file>        # one explicit file
pnpm --filter @muse/<pkg> test -- -t "<name>"   # one test by name
```

`pnpm test:changed` (scripts/test-changed.mjs) is the operationalized form
of this rule — it uses vitest's `related` (Vite module-graph dependency
tracking) so editing a leaf file runs a handful of tests, editing a central
one runs more, and a clean tree runs nothing. Reach for it FIRST.

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

The decision table, TS7 compatibility audit, performance measurements, and
official sources behind these rules live in
[`../../../docs/development/testing-strategy.md`](../../../docs/development/testing-strategy.md).
