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
- [Anticipation] A proactive notice surfaces the user's related notes for the imminent item's topic, unasked (Muse investigated an unstated need) — `muse proactive` daemon with notes configured — `@muse/mcp` notes-investigator.test.ts "surfaces a finding citing the real note for a matching imminent item" + proactive-loop "autonomously investigates the unstated need and surfaces the finding in the unasked notice" — P0-b3
- [Autonomy] On an under-specified imperative ("do it", no object/referent) the agent is steered to ask ONE clarifying question instead of hallucinating an action — wired live into the agent-runtime context pipeline — any `muse ask`/chat/API turn — `@muse/agent-core` clarify-directive.test.ts "prepends a clarify directive when the lone user message is under-specified" + "does NOT fire when a prior assistant turn makes it a confirmation" — P0-b4
- [Anticipation] The proactive daemon delivers an imminent-item notice to a REAL channel API (not a fake registry) — `runDueProactiveNotices` over a real `TelegramProvider`'s HTTP send — proactive daemon with a messaging provider + tasks/calendar configured — `@muse/api` proactive-notice-delivery.test.ts "POSTs an imminent-task notice over the real provider's HTTP send and dedupes on the next tick" (asserts Bot API URL + chat_id + text, real dedupe sidecar) — P2-b1
- [Anticipation] Anticipatory prep — the imminent-item notice carries the related doc ("here's the doc") on the SAME real-channel POST — real `LocalDirNotesProvider` + `createNotesInvestigator` wired into `runDueProactiveNotices` over a real `TelegramProvider`'s HTTP send — proactive daemon with notes + a messaging provider configured — `@muse/api` proactive-notice-delivery.test.ts "delivers anticipatory prep (the related doc) in the POST when an investigator is wired" (POST body carries the announcement + "Related notes: …", decoy excluded) — P2-b2
- [Presence] Muse perceives the user's environment unasked — an ambient change (e.g. the active window) measurably alters a subsequent agent answer — `applyAmbientContext` wired into the live agent-runtime pipeline behind an opt-in `ambientSnapshotProvider` (off by default, fail-open, untrusted-field sanitised) — any `runtime.run` with an ambient provider configured — `@muse/agent-core` ambient-context-runtime.test.ts "an ambient change measurably alters a subsequent agent answer" + "is off by default" — P3-b1
- [Autonomy] Calendar WRITE (create / move / cancel) is contract-faithfully exercised — not read-only — across the real Google, CalDAV and macOS providers with only the transport (fetch / osascript spawn) faked — `muse calendar` write paths / agent calendar tool — `@muse/calendar` calendar-write-contract.test.ts (Google POST/PATCH/DELETE w/ Bearer+JSON; CalDAV PUT/REPORT→PUT/DELETE w/ Basic+ICS; macOS make-new-event/delete AppleScript over the real osascript spawn) — P4-b1
- [Presence] Voice round-trip works end-to-end — captured mic audio is transcribed, the transcript reaches the agent, the reply is synthesised and played — `muse listen` (push-to-talk) — `@muse/cli` commands-listen.test.ts "captured audio is transcribed, sent to the agent, the reply is synthesised and played" drives the real `registerListenCommand` action with only mic spawn / STT / TTS / `/api/chat` / playback faked, asserting each stage's data flowed — P4-b2
- [Autonomy] A standing objective ("watch X / keep trying until Z / tell me when W") registered by the user survives a process restart and the ~20-min loop boundary as durable on-disk state — `~/.muse/objectives.json` via `addObjective`/`readObjectives` — `@muse/mcp` personal-objectives-store.test.ts "register → restart → still tracked: a registered objective survives a fresh read" (+ accumulation across independent registrations, idempotent register, corrupt-quarantine) — P5-b1
- [Autonomy] A standing objective is autonomously re-evaluated on a tick: condition met → its action fires once and it is durably marked done; unmet → exponential-backoff retry; unmeetable or attempts-exhausted → durably escalated (never silently dropped) — objective re-evaluation daemon (`runDueObjectives`) — `@muse/mcp` objective-evaluation-loop.test.ts "condition flips → action fires once and the objective is durably marked done" + "unmet → exponential backoff" + "unmeetable → durably escalated" + "unmet too many times → escalates" — P5-b2
- [Autonomy] A standing objective acts as the user only under recorded consent — a met objective performs a real (HTTP-faked) external action carrying the user's scoped service credential ONLY when a matching consent record exists; absent/scope-mismatched consent is fail-closed (no credential use, no HTTP) — `runDueObjectives` act via `performConsentedAction` over `~/.muse/consents.json` — `@muse/mcp` consented-action.test.ts "consent recorded ⇒ the real external request fires carrying the scoped credential" + "fail-closed: no recorded consent ⇒ no HTTP call" + "scope is never broadened implicitly" + "end-to-end: a met objective performs the real external action … and is marked done" — P5-b3
- [Presence] Every autonomous action Muse takes on the user's behalf — performed OR refused — produces a durable, append-only, rationale-bearing log entry (what / why / when / result) the user can review — `~/.muse/action-log.json` via `appendActionLog`/`queryActionLog` (newest-first, user-scoped) — `@muse/mcp` personal-action-log-store.test.ts "an autonomous consented action produces a rationale-bearing log entry the user can query" + "a fail-closed refusal is also logged" + append-only / corrupt-quarantine — P6-b1
