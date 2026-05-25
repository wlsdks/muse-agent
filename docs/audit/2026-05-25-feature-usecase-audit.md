# Feature ↔ Use-case Audit — 2026-05-25

A full cross-reference of Muse's **user-facing surface** against the code and
tests that back it, mapping each feature to a concrete single-user use-case.
Produced by a planner-agent team (4 domain auditors + 1 red-team reviewer),
every `file:line` claim independently re-verified before inclusion.

Scope of truth: local `main` HEAD `a4b1ae2b` (6 commits ahead of `origin`).

## The three questions this audit answers

1. **Is there a planning doc / are the docs accurate?** — Yes, but vision is
   *layered by audience*, not a single PRD: `README.md` (positioning),
   `AGENTS.md` (cross-agent brief), `docs/FEATURES.md` (Korean 기능 정의서),
   `docs/goals/OUTWARD-TARGETS.md` (self-evolving roadmap, loop-owned),
   `docs/goals/CAPABILITIES.md` (append-only capability ledger). Accuracy is
   **high but not perfect** — concrete divergences are listed below.
2. **Are they up to date?** — Yes. FEATURES/EXPANSION updated today,
   CAPABILITIES/OUTWARD-TARGETS within a day. No dead documents found.
3. **Does every feature have a use-case?** — **Mostly yes.** Of the user-facing
   surface, the overwhelming majority maps to a real single-user JARVIS
   scenario. The exceptions (shipped-but-inert capabilities, vestigial
   enterprise-era columns, one un-gated outbound path) are itemised in
   **Findings** and are the actionable output of this audit.

## Status legend

- ✅ **verified** — code + test exist, real single-user use-case nameable
- ⚠️ **stale** — a doc claim diverges from the code
- 🕳️ **gap** — exists but untested, or use-case is weak/unclear
- 👻 **orphan** — code exists, no real single-user use-case (or vestigial)

## Summary

| surface | items | ✅ | 🕳️ gap | ⚠️/👻 notes |
|---|---|---|---|---|
| CLI commands | 68 | 49 | 19 (18 no test + 1 helper-only) | 0 orphan — no enterprise leftovers in CLI |
| MCP servers (`muse.*`) | 23 | 21 | 2 (proactive untested, messaging) | — |
| Built-in MuseTools | ~25 | most | home_entities/notes_index execute-path untested | **messaging.send: outbound-safety gap (F-1)** |
| Model providers | 12 | 6 core | 6 compat presets (baseUrl-value untested) | LM Studio overstated; Cerebras doc drift; **Anthropic vision unwired** |
| Subsystems | 13 | 11 | skills invoke-path, multi-agent default-worker | persona_id vestigial column; live-voice inert |

**No enterprise-SaaS orphans survive in the user-facing CLI** — the
personal-pivot cleanup held. The leftovers found are narrower (one DB column,
one unsurfaced monitor) and listed below.

---

## CLI commands (apps/cli/src)

68 top-level commands audited. Registered-name notes: `jobs`→`job`,
`scheduler-setup`→`scheduler`+`setup`, `setup-local/voice`→`setup local/voice`
subcommands, `tools-admin`→`tools`; `notes-rag` attaches subcommands to `notes`;
`weather`/`time` register via `registerWeatherCommand`/`registerTimeCommand`
(`weather.ts:18`, `timezone.ts:16`), not `commands-*.ts`.

**✅ verified (49):** actions, agents, approval, approvals, ask, auth, brief,
calendar, completion, config, contacts, debug, doctor, email, episode, export,
feeds, followup, glance, history, home, inbox, job, listen, mcp, messaging,
notes, notes-rag, objectives, open, orchestrate, pattern, proactive, read,
recall, remind, routine, runs, scheduler, search, settings, setup local, skills,
tasks, telemetry, today, vision, watch-folder, web-action, webhook.

**🕳️ gap — no test (18):** analytics, cost, import, latency, maintenance,
memory, metrics, persona, remember, session, setup voice, show, specs,
**status** (`commands-status.ts` is 775 lines, the flagship dashboard, zero
test), tools (tools-admin), traces, trust, voice.

**🕳️ gap — helper-only test (1):** agent-notices (`commands-agent-notices.test.ts`
tests only `formatNoticeStamp`; the streaming command path is untested).

No 👻 orphans: `trust --user`/`memory --user` use `$MUSE_USER_ID||$USER` as the
single-user identity key for a local file, not multi-tenant routing.

---

## MCP servers (`muse.*`, packages/mcp/src)

**✅ verified (21):** calendar, context, crypto, diff, episode, fetch, followup,
fs, history, json, math, notes, pattern, regex, reminders, search, status,
tasks, text, time, url — each with a `file:line` registration and a test in
`mcp/test/mcp.test.ts` or a dedicated file.

**🕳️ gap (2):**
- **muse.proactive** (`loopback-proactive.ts:25`) — `history` tool has no
  dedicated test describe-block (the same file is read indirectly by
  `muse.status`, which *is* tested).
- **muse.messaging** — see **F-1** (this is the critical one).

## Built-in MuseTools (the tools the local Qwen calls)

Verified ✅ with code+test+use-case: `home_state`, `home_action`, `web_action`,
`weather`, `world_time`, `remember_fact`, `email_send`, `email_recent`,
`read_email`, `search_email`, `find_contact`, `add_contact`, `remove_contact`,
plus the loopback CRUD tools (`evaluate`, `hash`, `encode_query`, `diff_ms`, …).

🕳️ execute-path untested: `home_entities` (`smart-home-tool.ts:125` — only
schema registered, read-only so no safety risk), `notes_index`
(`loopback-status.ts:279` — read-only).

Tool-calling reliability (per `.claude/rules/tool-calling.md`): `email_recent`
vs `search_email` is correctly disambiguated with "use when / not when" lines
and a relevance test (`autoconfigure/test/email-search-relevance.test.ts`). The
four `*.search` tools (notes/episode/reminders/tasks) all carry a `domain`
field so `DefaultToolFilter` narrows them — a managed risk worth a `smoke:live`
check when several appear in one context window.

---

## Model providers (packages/model)

| provider | implemented | tested | status |
|---|---|---|---|
| OpenAI (Responses `/v1/responses`) | `adapter-openai.ts:35` | yes | ✅ |
| Anthropic | `adapter-anthropic.ts:28` | yes | ✅ (but vision unwired — F-3) |
| Gemini | `adapter-gemini.ts:30` | yes | ✅ |
| OpenRouter | `adapter-openai.ts:137` | yes | ✅ |
| Ollama | `adapter-ollama.ts:35` | yes | ✅ |
| OpenAI-compatible (LM Studio etc.) | `provider-base.ts:71` | generic | ⚠️ no named LM Studio class/preset (F-4) |
| Groq / DeepSeek / Together / Mistral / Moonshot / Cerebras | `openai-compat-presets.ts:22-29` | envKey+model only (`setup-status.test.ts:210-235`); baseUrl values unasserted | 🕳️ |
| Diagnostic (internal/test) | `adapter-diagnostic.ts:28` | yes | ✅ |

Retry policy matches `architecture.md` exactly (`provider-base.ts:65-69`:
429/408/5xx retryable, other 4xx fail-fast; `provider-base.test.ts`).
`sanitizeGeminiSchema` strips exactly the documented keyword set
(`provider-gemini.ts:95-105`).

### Vision support matrix (resolves the FEATURES.md "⚙️ vague" gap)

| provider | `capabilities.vision` | images actually serialized? |
|---|---|---|
| OpenAI **Chat Completions** path | true | ✅ yes (`provider-openai.ts:93-109`) |
| OpenAI-compatible / OpenRouter | true | ✅ yes (same path) |
| Gemini | true | ✅ yes (`provider-gemini.ts:186-203`) |
| OpenAI **Responses** path | true | ❌ no (`toOpenAIResponsesRequest` input_text only) |
| **Anthropic** | **true** | ❌ **no — silently dropped** (`toAnthropicMessage` has no attachment branch) |
| Ollama (local) | false | ❌ no (consistent — declared false) |

---

## Subsystems (packages/)

✅ verified, with a real single-user use-case and tests: **calendar** (multi
-provider events/free-busy), **memory** (trim + summaries + auto-extracted user
facts), **scheduler** (cron + locks), **voice** (Whisper/Piper via `muse listen`),
**messaging** (channels + fail-close approval gate `channel-approval-gate.ts:87`),
**policy** (guards fail-close, hooks fail-open — both confirmed per CLAUDE.md
contract), **autoconfigure**, **observability**, **runtime-state**, **resilience**,
**agent-specs**.

🕳️ gaps:
- **multi-agent** — orchestrator is *not* wired into `buildMuseContext`; it lives
  per-request in `apps/api/src/multi-agent-routes.ts` with no pre-seeded
  workers, so for a fresh personal user it is a blank framework (no
  multi-tenancy — not an enterprise orphan, but a thin solo use-case).
- **skills** — only `skill-parser.test.ts` (which does cover
  `FileSystemSkillLoader`); `InMemorySkillRegistry` and the full
  load→register→invoke path are untested, despite `muse.skills.run` being a
  user-facing path.

---

## Findings (the actionable output) — by severity

### F-1 — CRITICAL: `muse.messaging.send` bypasses the outbound-safety gate

`packages/mcp/src/loopback-messaging.ts:265` calls
`registry.send(providerId, { destination, text })` **directly** — no draft-first
step, no fail-close approval gate, no action-log entry. The whole file contains
zero `approval`/`gate`/`draft`/`actionLog`/`consent` references. Its only test
(`mcp/test/mcp.test.ts:~4113`) asserts the happy path; there is **no
deny/timeout assertion**.

This violates `.claude/rules/outbound-safety.md` — a stated non-negotiable —
for messages sent to a third party on Telegram/Discord/Slack/LINE. Every other
outbound actuator wraps the send: `email_send`→`sendEmailWithApproval`
(`email-tool.ts:56`), `web_action`→`performWebActionWithApproval`, `home_action`
→`performHomeActionWithApproval`. The `risk:"write"` flag (`loopback-messaging.ts:304`)
only governs *tool exposure* (`tools/index.ts:238` blocks it absent mutation
intent) — that is **not** the user-confirmation gate the contract requires.

**Recommendation (out of scope for this docs PR — needs its own TDD + smoke:live
slice):** route `muse.messaging.send` through the same approval-gate seam as
`email_send`, and add the deny/timeout = no-external-effect test the contract
mandates. Until then, treat the MCP messaging-send path as unsafe for
autonomous use.

### F-2 — HIGH: provider vision claims are inaccurate (Anthropic silently drops images)

`AnthropicProvider.capabilities.vision = true` (`provider-anthropic.ts:181`,
inherited from `defaultRemoteModelCapabilities`, never overridden) but
`toAnthropicMessage` (`provider-anthropic.ts:58-89`) has no attachment branch —
images are silently discarded with no error. The native OpenAI **Responses** path
(`toOpenAIResponsesRequest`) has the same gap. Vision is real only on the OpenAI
Chat-Completions path, OpenAI-compatible/OpenRouter, and Gemini. FEATURES.md's
vague "⚙️ vision (setup required)" is now resolved by the matrix above.
**Recommendation:** override `vision:false` for Anthropic until attachment
serialization lands (1-line capability fix — code, not docs).

### F-3 — MEDIUM: shipped-but-inert capabilities

- **live-voice / Gemini-Live / wake-word** (`packages/voice`): exported and
  unit-tested via fakes, but neither `commands-listen.ts` nor `voice-routes.ts`
  imports them — no app-surface wiring.
- **multi-agent orchestrator**: see subsystem gap above.
- **GuardBlockRateMonitor.alerting** (`packages/policy/src/guard-monitor.ts`):
  the alert flag is computed but never surfaced to any channel/endpoint — benign
  for a single user, but a platform-monitoring carry-over.

### F-4 — LOW: documentation drift

- `CLAUDE.md:67` memory path points at the old `-Users-stark-ai-Muse` →
  should be `-Users-jinan-side-project-Muse`. **(Fixed in this PR.)**
- README lists **Cerebras** as a provider; `AGENTS.md:32` omits it. **(Fixed.)**
- README/`architecture.md` present **LM Studio** as a named provider family;
  in code it is only `OpenAICompatibleProvider` + a user-supplied `baseUrl`
  (no class, no preset). **(Clarified in docs.)**
- `docs/FEATURES.md` (Korean) omits these working commands: `maintenance`,
  `open`, `routine`, `session`, `show`, `import`, `telemetry`; and marks a few
  setup-required items as `✅`. **(Reconciled.)**

### F-5 — LOW: vestigial enterprise-era column

`packages/db/src/schema.ts:228` `ScheduledJobTable.persona_id` is never read by
the dispatcher (`scheduler/src/index.ts:269` hardcodes `userId:"scheduler"`). A
migration-era leftover. Flagged for a future loop cleanup (DB migration — not a
docs change).

---

## Off-limits files (read-only — reported, not edited)

Per the audit's scope, loop-owned / `IMMUTABLE-CORE` files were not modified.
Issues to route through the loop / a human `[core-change: human]` commit:

- `docs/goals/CAPABILITIES.md` — F-1 (messaging-send) and F-2 (Anthropic vision)
  mean two capability lines describe surfaces that don't meet the
  outbound-safety / vision contract end-to-end; the loop's falsification step
  should re-examine them.
- No edits were made to `OUTWARD-TARGETS.md` or `.claude/rules/*`.

## Method note

Domain-split audit + independent red-team verification. Two auditor claims were
**downgraded by the reviewer** and excluded from the docs: compat presets *do*
have an envKey/model test (not "untested"), and `FileSystemSkillLoader` *is*
tested (only the registry/invoke path is not). Evidence-before-assertion held.
