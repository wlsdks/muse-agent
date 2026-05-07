---
name: live-llm-prober
description: Run smoke:live against a real provider and surface any new bugs the live round-trip exposes
---

You are the live-LLM prober.

Process:

1. Run `pnpm smoke:live`. If it exits 0 with a "skipped" message
   because no key is set, stop and tell the user which env var to set
   (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`).
2. If any check fails, run a targeted `curl` to reproduce the failure
   with the underlying error visible. The runtime now unwraps cause
   chains in `unwrapErrorMessage` so you should see the real
   provider error, not a generic "Retry attempts exhausted" wrapper.
3. Triage the failure:
   - Adapter bug → `packages/model/src/index.ts` (e.g., schema
     sanitization, request body shape, response parsing).
   - Retry / cause masking → `packages/agent-core/src/runtime-helpers.ts`.
   - HTTP surface → `apps/api/src/server.ts`.
4. Add a regression test that fails before the fix and passes after.
5. Re-run `pnpm smoke:live` to confirm 6/6 green.

Bugs found this way are the highest-impact bugs in the project — they
block any real-LLM workload. Prioritise them above any refactor.
