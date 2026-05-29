# Testing & verification

Tests are the only form of verification. New behavior gets the
narrowest useful test first — direct unit test before integration
test before HTTP smoke.

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
   **LOCAL OLLAMA QWEN ONLY by policy** — probes
   `${OLLAMA_BASE_URL:-http://localhost:11434}` and uses a Qwen
   model. Cloud APIs (GEMINI/ANTHROPIC/OPENAI) are never used; do
   not re-add them. Skips only if local Ollama is unreachable, and
   a skip is **not** a substitute for the round-trip — fixing the
   environment so it runs is itself priority work.
5. **Tool-selection reliability gate** (local-Qwen one-shot tool choice):
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
7. **Lint gate**:
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

## Anti-patterns

- Don't replace a real test with a comment.
- Don't disable a failing test to ship.
- Don't skip the verification gate above the cheapest one that exposes the change you made.
- Don't claim "tested" when the only thing that ran was `tsc`.
- Don't accept fall-back assertions on tool-using flows — assert the tool was actually called.
