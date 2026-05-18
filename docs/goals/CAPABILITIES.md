# Capabilities — the loop's only success metric

Append-only inventory of **real, user-exercisable** Muse
capabilities. One line per capability: what the user can do, the
exact command/surface, and the executable check that proves it.

Rules (enforced by `.claude/rules/iteration-loop.md`):

- Every shipped outward goal MUST append exactly one new line here,
  backed by a test or smoke endpoint that exercises the capability
  end-to-end (assert the capability, not that code compiles).
- This file is append-only. Never delete or weaken a line. If a
  capability regresses, the iteration's job is to restore it.
- **The count of lines below = the loop's success metric.** If it
  has not strictly increased across the last 5 iterations, the next
  iteration's sole mandate is to add one real capability + its
  check. Flat capability over 5 iterations is the degeneration
  signal — act on it; never stop, never ask a human.

Format: `- [<axis>] <capability> — <command/surface> — <check>`
axis ∈ Reach | Anticipation | Autonomy | Presence

## Inventory

- [Reach] Ask any LLM provider behind one runtime — `muse ask "…"` (OpenAI/Anthropic/Gemini/OpenRouter/Ollama/LM Studio/compat) — `pnpm smoke:broad` chat endpoint
- [Reach] Real local-LLM round-trip on the loop PC's Qwen — `pnpm smoke:live` — `scripts/smoke-live-llm.mjs` (local Ollama Qwen, executes end-to-end)
- [Reach] Notes / tasks / calendar personal stores queried by the agent — `muse notes|tasks|calendar …` — `@muse/mcp` store tests + smoke:broad
- [Reach] Calendar across Local / Google / CalDAV / macOS — `muse calendar events --from --to` — calendar provider contract tests
- [Anticipation] Proactive notice loop (upcoming events / reminders) — proactive daemon tick — `apps/api` proactive tick tests
- [Anticipation] Self-queued follow-up promises fire later — followups daemon — `runDueFollowups` tests
- [Autonomy] Multi-step plan-execute over tools — `muse ask --with-tools` / plan-execute endpoint — smoke:broad plan-execute
- [Autonomy] Multi-agent sequential/parallel orchestration — orchestration endpoint — smoke:broad multi-agent
- [Presence] Voice in/out (Whisper / Piper / whisper.cpp) — `muse listen` / `--speak` — voice unit tests
- [Presence] Cross-session episodic recall surfaced into context — REPL across sessions — episodic-summariser tests
