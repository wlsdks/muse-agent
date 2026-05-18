# Capabilities — the loop's only success metric

Append-only inventory of **real, user-exercisable** Muse
capabilities. One line per capability: what the user can do, the
exact command/surface, and the executable check that proves it.

Rules (enforced by `.claude/rules/iteration-loop.md`):

- Every shipped outward goal MUST append exactly one new line here.
  The `<check>` MUST be a concrete automated test or smoke id that
  actually runs green under `pnpm check` / `pnpm smoke:broad` /
  `pnpm smoke:live` and asserts the *capability* end-to-end (not
  that code compiles). Prose with no runnable id is not a check.
- **Cross-time falsification:** every iteration's first action is
  to run the newest line's check and prove it still passes. A
  faked/broken line = the next iteration's whole job is to fix it.
- **Regression sweep:** every 10th iteration re-runs ALL checks;
  any regression = next iteration must restore it.
- A request/response-path capability whose `smoke:live` did NOT
  actually run is tagged `[UNVERIFIED-LIVE]`; it does not count
  until a later iteration runs the live check and drops the tag.
- Append-only. Never delete or weaken a line.
- **The success metric is NOT this line count.** It is
  `OUTWARD-TARGETS.md` bullets flipped `[ ]`→`[x]`. A line here is
  the *evidence* for a flip (cite the bullet it delivers); a line
  that adds no bullet flip is thin and does not satisfy the metric.
  No bullet flipped in the last 5 iterations ⇒ next iteration's
  sole mandate is to flip one end-to-end. Flat bullets =
  degeneration; act on it — never stop, never ask a human.

Format: `- [<axis>] <capability> — <command/surface> — <runnable check id> — P<n> bullet`
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
- [Presence] Proactive notices route to the active terminal and fall back to messaging when it goes stale (no black-hole) — `muse proactive watch` (TTY) then idle past the active-session window — `@muse/mcp` mcp.test.ts "falls back to messaging when terminal presence is stale"
- [Presence] An inbound consumer drains the messaging inbox and runs the FULL agent runtime per message, replying on the originating channel (not append-to-soft-context) — wired bot inbox with `MUSE_INBOUND_REPLY_ENABLED=1` — `@muse/api` inbound-reply-tick.test.ts "answers each new inbox message via the agent, replies to its source, and is idempotent" (integration inbound→run→reply) — P1-b1
- [Presence] The agent reply is POSTed back over the real channel provider's HTTP send (chat_id + text), verified through a contract-faithful HTTP fake of a real provider, never a fake registry — inbound→reply over `TelegramProvider` — `@muse/api` inbound-reply-tick.test.ts "delivers the agent reply over a real provider's HTTP send — contract-faithful, not a fake registry" — P1-b2
- [Presence] A channel chat is a continuous session — the user's next message on the same channel carries prior turns (user + Muse) into the agent, isolated per {provider,source} — multi-turn inbound on a wired channel — `@muse/messaging` inbound-threaded-runner.test.ts "prepends prior turns on the next message of the same channel, isolated per channel" — P1-b3
- [Autonomy] A channel-triggered risky tool (write/execute) is NOT executed without approval — it posts an in-chat approval prompt back over the real provider's HTTP and fail-closed denies; read tools pass — risky tool during inbound→agent run on a wired channel — `@muse/messaging` channel-approval-gate.test.ts "blocks a risky tool and posts an in-chat approval prompt over the real provider's HTTP" — P1-b4
- [Anticipation] Muse grows its user-model from real use on a tool-using turn (channel chats included — the run now carries a channel-derived userId; the wired afterComplete auto-extract hook stores the fact) — talk to Muse on a wired channel / tools-enabled API turn — `@muse/agent-core` auto-extract-tool-turn.test.ts "stores an extracted fact under the run's userId after a tool-using turn" — P0-b1
- [Anticipation] Cross-session recall is embedding-similarity in production — a paraphrase that shares no tokens with a past session recalls it (Jaccard misses); zero-cost local-Ollama embedder, fail-open to Jaccard if down — REPL/API across sessions — `@muse/agent-core` episodic-recall-embedding.test.ts "uses embedding cosine when an embedder is wired — paraphrase recalls" + "fail-open: a throwing embedder degrades to Jaccard" — P0-b2
