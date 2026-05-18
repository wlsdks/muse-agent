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
3. **Diagnostic-provider HTTP smoke** (49 endpoints, no API key):
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
5. **Lint gate**:
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
