# Context Engineering Roadmap

Tracker for the 5-phase context-engineering surface that lifts Muse
toward the JARVIS-style "the assistant already knows" feel. Each phase
moves stored runtime data (memory / inbox / time / summaries) into the
system prompt automatically, instead of waiting for the agent to call
a tool.

## Status snapshot

| # | Phase | State | Toggle |
|---|---|---|---|
| 1 | Active Context Injection | Shipped | `MUSE_ACTIVE_CONTEXT_ENABLED` (default on) |
| 2 | Messaging Inbox Auto-Injection | Shipped | `MUSE_INBOX_CONTEXT_ENABLED` (default on when any messaging token is set) |
| 3 | Episodic Recall (token-overlap, store-backed) | Shipped | `MUSE_EPISODIC_RECALL_ENABLED` (default on; reads persisted summaries from Postgres) |
| 4 | Context-aware Tool Filter | Shipped | `MUSE_TOOL_FILTER_ENABLED=true` (opt-in) |
| 5 | Importance-weighted Compaction | Shipped | `MUSE_COMPACTION_STRATEGY=importance` (default `temporal`) |

## What every phase does

All five phases share the same shape:
1. A small interface lives in `@muse/agent-core` (no domain deps).
2. A concrete provider lives in the owning package (`@muse/messaging`,
   `@muse/memory`, …) or in `@muse/agent-core` as a default impl.
3. A transform in `packages/agent-core/src/context-transforms.ts`
   appends a `[Section]` block to the first system message via
   `appendSystemSection`. Always fail-open — provider error returns
   the input untouched.
4. `AgentRuntime.run` / `stream` thread the transform after
   `applyUserMemory` and before `applyStoredConversationSummary`.
5. `packages/autoconfigure` reads env vars and instantiates the
   provider when the user opted in.

## Phase 1 — Active Context

**What.** Injects `[Active Context]` with current time, weekday,
timezone, working-hours boolean, active task, current focus.

**Files.**
- `packages/agent-core/src/time-helpers.ts`
- `packages/agent-core/src/active-context.ts` —
  `DefaultActiveContextProvider`
- `packages/autoconfigure/src/personal-providers.ts` —
  `buildActiveContextProvider`

**Env.**
- `MUSE_ACTIVE_CONTEXT_ENABLED` (default `true`)
- `MUSE_DEFAULT_TIMEZONE` (fallback when user memory has no
  `preferences.timezone`)
- User memory keys read: `preferences.timezone`,
  `preferences.working_hours` (e.g. `"9-17"`),
  `facts.current_focus` / `preferences.current_focus`

**Status.** Live. Smoke verification: "지금 몇 시야?" should answer
without a tool call.

## Phase 2 — Messaging Inbox

**What.** Surfaces unread inbound (Slack / Discord / Telegram / LINE)
as `[Recent Messages]`, grouped per provider:source. Cursor advances
on every resolve so the same message isn't re-injected.

**Files.**
- `packages/messaging/src/inbox-injection-cursor.ts`
- `packages/messaging/src/inbox-surface.ts` —
  `FileBackedInboxContextProvider`
- `packages/agent-core/src/inbox-context.ts`
- `packages/autoconfigure/src/personal-providers.ts` —
  `buildInboxContextProvider`

**Env.**
- `MUSE_INBOX_CONTEXT_ENABLED` (default `true`; auto-skips when no
  messaging token is registered)
- `MUSE_INBOX_INJECT_LIMIT` (per-provider cap, default 20)
- `MUSE_INBOX_INJECT_TOTAL_LIMIT` (cross-provider cap, default 80)
- Cursor files: `~/.muse/{providerId}-inbox-injection.json`
  (overrideable via `MUSE_{ID}_INBOX_INJECTION_CURSOR_FILE`)

**Status.** Live. Daemons in `apps/api` (telegram-poll-tick,
channel-poll-tick) feed the inbox files; this transform reads them.

## Phase 3 — Episodic Recall (token-overlap, store-backed)

**What.** At each request, the runtime lazy-fetches recent
conversation summaries from `ConversationSummaryStore.listAll`,
scores them against the latest user prompt by Jaccard token overlap,
and injects top-K as `[Episodic Memory]`. Runs entirely in-process
on the Muse Postgres — no embedding API call, no pgvector, no
external dependency.

**Files.**
- `packages/agent-core/src/episodic-recall.ts` —
  `EpisodicRecallProvider` interface, `InMemoryEpisodicRecallProvider`
  (static episode list), `StoreBackedEpisodicRecallProvider` (lazy
  fetch from any source implementing `listAll`), `renderEpisodicSection`
- `packages/memory/src/memory-conversation-summary-store.ts` —
  `listAll` on both InMemory + Kysely stores, `userId` column mapped
  in `conversation_summaries`
- `packages/db/src/migrations.ts` — `0002_conversation_summaries_user_id`
  (adds `user_id` column + index; **no pgvector**)
- `packages/autoconfigure/src/personal-providers.ts` —
  `buildEpisodicRecallProvider(env, summaryStore)`

**Env.**
- `MUSE_EPISODIC_RECALL_ENABLED` (default `true`; set `false` to skip)
- `MUSE_EPISODIC_RECALL_TOPK` (default 3)
- `MUSE_EPISODIC_RECALL_MAX_FETCHED` (default 200 — cap on
  summaries pulled per resolve, keeps a long-running personal
  setup from drifting into O(n) cost over time)
- `MUSE_EPISODIC_RECALL_MIN_SCORE` (default 0.15 — Jaccard
  threshold)

**Wiring.** `autoconfigure` builds the provider when (a) the
conversation-summary store is persisted (`MUSE_CONVERSATION_SUMMARY_PERSIST`
default true) and (b) the env flag is on. `AgentRuntime.run` / `stream`
already thread the transform through the request pipeline. New
sessions become searchable the moment their compaction summary is
saved — no restart required.

**Trade-offs (why token-overlap is fine for personal scope).**
- Pros: zero infra outside the Postgres already in use, zero API
  cost, deterministic, easy to debug.
- Cons: paraphrase / multi-language recall is weaker than an
  embedding-backed search. Korean morphology (하다 / 한 / 했던) is
  partially absorbed via lowercase + CJK-aware tokenization but
  not as well as a semantic embedding would.
- Threshold for swapping in an embedding-backed provider: corpus
  grows past ~hundreds of active sessions, OR cross-language recall
  starts feeling necessary, OR a query consistently misses a known
  prior session. The `EpisodicRecallProvider` interface is the swap
  point — the runtime doesn't care which impl is wired.

## Phase 4 — Tool Filter

**What.** Drops irrelevant tools from the catalog advertised to the
model each request. Uses (a) `MuseToolDefinition.domain`, (b) the
user prompt keywords, (c) explicit `metadata.toolScopes` hints.

**Files.**
- `packages/agent-core/src/tool-filter.ts` — `DefaultToolFilter`,
  `inferDomain`
- `packages/tools/src/index.ts` — `MuseToolDefinition.domain?`
- `packages/autoconfigure/src/personal-providers.ts` —
  `buildToolFilter`
- Wire-in: `AgentRuntime.modelTools` post-filter

**Env.**
- `MUSE_TOOL_FILTER_ENABLED=true` (default off — needs tool
  population with `domain` tags first)

**Outstanding work.**
- Tag every existing tool with a `domain` value across
  `packages/tools/` and the loopback MCP servers. Today the filter
  falls back to a name-prefix heuristic for `muse.messaging.*`,
  `muse.calendar.*`, `muse.tasks.*`, `muse.notes.*`, `muse.time.*`,
  `muse.context.*`. Untagged tools stay always-on.

## Phase 5 — Importance-weighted Compaction

**What.** When `compactionStrategy: "importance"` is set, the trim
machinery scores each message via `scoreMessageImportance` and drops
low-importance ones first. Tool-call pair integrity is preserved.

**Files.**
- `packages/memory/src/message-importance.ts`
- `packages/memory/src/memory-token-trim.ts` — new
  `trimByImportance` pass ahead of `trimOldHistory`

**Env.**
- `MUSE_COMPACTION_STRATEGY` (`temporal` | `importance`, default
  `temporal`)
- `MUSE_COMPACTION_IMPORTANCE_THRESHOLD` (default `0.5`)

**Outstanding work.**
- Surface `importanceContext` (active task / focus) from
  `ActiveContextProvider` into `ConversationTrimOptions` —
  currently the trim sees only the static threshold. Plumbing-only
  change in `AgentRuntime.prepareModelRequest`.

## Cross-phase verification

```bash
pnpm check                              # 26 workspaces, all green
pnpm lint                               # 0 errors / 0 warnings
pnpm smoke:broad                        # 49 endpoints, diagnostic
GEMINI_API_KEY=… pnpm smoke:live        # 6 endpoints, real model
```

Live-smoke is the gate for Phase 1/2/3 changes (they touch the
request path). Phase 4/5 are gated by unit + integration tests.

## Carrying notes / open decisions

- **Embedding path is intentionally out of scope.** For personal
  single-user use, the token-overlap baseline carries Phase 3 with
  zero infra cost. Re-introducing pgvector / `ModelProvider.embed`
  is a future option once the corpus / language demands it, not a
  default.
- **Inbox cursor reset**: the `lastInjectedAt` cursor accumulates per
  source. No eviction today — file stays small but isn't bounded.
  Worth revisiting once we have >50 channels active.
- **Tool-domain tagging sweep**: a separate iter should tag every
  tool in `packages/tools/` and the MCP loopback servers so
  `MUSE_TOOL_FILTER_ENABLED=true` becomes a sensible default.
