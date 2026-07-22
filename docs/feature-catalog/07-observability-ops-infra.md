# Domain 07 — Observability / Ops / Infrastructure / Surfaces / Architecture

Catalog + verification. Repo: `/Users/jinan/side-project/Muse`. Date 2026-06-14.
Verification legend: ✅ ran live · 🧪 has tests · ⬜ code-only · ⚠️ broken/suspect.

CLI base used: `node /Users/jinan/.nvm/.../v24.16.0/bin/node apps/cli/dist/index.js <cmd> --help </dev/null`.

---

## 0. Headline counts (for doc cross-check)

- **Top-level CLI commands: 102** (deduped, parsed from `muse --help`). README/docs "100+ CLI commands" is ACCURATE (slightly conservative). Full list in `/tmp/muse-catalog/_cmds.txt`.
- **Workspace packages: 27** under `packages/` (a2a, agent-core, agent-specs, auth, autoconfigure, browser, cache, calendar, db, macos, mcp, memory, messaging, model, multi-agent, observability, policy, prompts, recall, resilience, runtime-settings, runtime-state, scheduler, shared, skills, tools, voice). + 4 apps (api, cli, web, desktop) + 1 crate (runner).
- **muse.* in-process loopback servers: 24 canonical distinct names** (`grep '"muse.X"'` in `packages/mcp/src`). An earlier count of "27" wrongly included the `notes-multi`/`tasks-multi` variants and a phantom `muse.png` (a test-image filename, not a server). README's "~24" is correct.
- **apps/api route groups registered in server: 26** `register*Routes` calls (35 `register*Routes` functions exist; 9 are admin/agent/auth/session/mcp/user-memory *compat* shims layered under `registerCompatibilityRoutes`).
- **apps/web views (panels): 13** (`apps/web/src/views/*.tsx`, non-test).
- **DB migrations: 2** named migrations in `migrations.ts` (`0001_runtime_state`, `0002_conversation_summaries_user_id`); 18 tables in `schema.ts`.

---

## 1. CLI ops commands (verification)

### doctor — runtime health check ✅ ran
- `muse doctor` runs model/MCP/calendar/scheduler/encryption/notes/messaging/searxng checks. Rich flag set: `--full`, `--json`, `--local`, `--resources` (live admission plus separately labelled probe/resident RSS), `--model-memory` (loopback-only Ollama loaded-model allocation; no generation), `--grounding` (scores faithfulness + false-refusal corpus), `--weaknesses` (Whetstone weakness ledger), `--run-outcomes` (grounding failure RATE over `.muse/runs`), `--calibration` + `--alpha <rate>` (conformal 'I'm not sure' threshold), `--watch` + `--interval`.
- Evidence: ran `doctor --local` → `Overall: WARN — 4 warning(s) (14 ok / 4 warn / 0 fail across 18 checks)`. Reports local-only ON (default), default model `ollama/gemma4:12b`, at-rest encryption gaps, official MCP (github/notion/linear/sentry) disabled-by-default.
- All four flag families from the prompt (`--weaknesses`/`--grounding`/`--run-outcomes`/`--calibration`) EXIST. 🧪 tests under apps/cli + compat-doctor.ts (17 symbols).

### metrics — observability roll-up ✅ help ⬜ live (server-only)
- `muse metrics show` = at-a-glance snapshot from `/api/admin/muse/snapshot`. Top desc: "Observability surfaces (SLO + drift + budget + token cost)".

### cost — token-cost tracking ✅ help ⬜ live (server-only)
- Subcmds: `daily` (per-day token totals + estimated cost over lookback), `top` (most expensive runs), `for <run-id>` (per-step token usage, alias `by-session`).
- ⚠️ requires API server: `cost daily` errored "Muse API not reachable at 127.0.0.1:3030"; no `--local`. So live-unverified here (admin snapshot path). Backed by `@muse/observability` `TokenCostQuery` (InMemory + Kysely impls over `metric_token_usage`).

### latency — latency metrics ✅ help ⬜ live
- Subcmds: `summary` (roll-up percentiles), `timeseries` (bucketed by day). Backed by `LatencyQuery` / `LatencySummary`.

### traces — trace events / spans ✅ help ⬜ live
- Subcmds: `list` (trace events or spans), `spans <trace-id>`, `tail` (poll `/api/admin/traces`). Backed by `TraceEventTable` / `HookTraceTable`.

### telemetry — runtime telemetry ✅ help ⬜ live
- Subcmds: `summary` (rolled-up over window, default 7d), `recent` (last N raw events).

### analytics — conversation analytics ✅ help ⬜ live
- Subcmds: `failures` (recurring failure patterns), `latency-distribution` (buckets).

### tools — tool usage stats ✅ help ⬜ live (server-only)
- Subcmds: `stats`, `accuracy` (per-tool success/failure ratios), `calls`, `ranking`. ⚠️ requires server (`tools stats` → API not reachable, no `--local`).

### debug — failed-run replay ✅ help ⬜ live
- Subcmds: `replay` (recent failed-run replay captures), `replay-show <id>`, `context <runId>` (exact messages + tool calls the LLM saw). Backed by `DebugReplayCaptureTable` + `runtime-state/debug-replay.ts`. 🧪 `compat-debug-replay.test.ts`.

### settings — runtime settings ✅ help ⬜ live (server-only)
- Subcmds: `list / get <key> / set / unset / refresh`. Backed by `@muse/runtime-settings` + `RuntimeSettingTable`. ⚠️ no `--local` (server-only).

### privacy — encrypted-at-rest inventory ✅ ran
- Read-only inventory of confided stores (encrypted vs plaintext + key strength). `--json`.
- Evidence ran: user-memory PLAINTEXT⚠, episodes/contacts/playbook "not created yet", action-log PLAINTEXT⚠, tasks/reminders/notes "plaintext (not yet encryptable)". Confirms encryption coverage is store-by-store and INCOMPLETE (matches MEMORY note: memory/episodes/action-log encryptable; contacts/playbook/tasks/etc not yet).

### maintenance — housekeeping ✅ help (NOT run — mutating)
- Subcmds: `compact` (rotate goal-079 archive sidecars → `~/.muse/archive/*.gz`), `prune-activity` (trim `~/.muse/activity.jsonl`), `prune-log` (trim `~/.muse/notifications.log`). Not executed (writes).

### mcp — MCP server management ✅ help ⬜ live (server-only for list/status)
- Subcmds: `config-path`, `config-show`, `config-doctor` (validate every `~/.muse/mcp.json` entry, per-entry no-bail), `config-add`, `use <preset>`, `list`, `status` (per-server health + reconnect schedule), `add`, `connect`, `disconnect`, `tools`, `call`. ⚠️ `mcp list` needs server (no `--local`). Allowlist enforcement two-layered (register + connect) per architecture.md `McpSecurityPolicy`.
- `serve` (✅ ran live) — the REVERSE direction: runs Muse itself as a local, read-only MCP stdio server for another agent (Claude Code / Cursor / Codex) to connect to. Exactly 3 tools: `muse_recall` (cited grounded Q&A over notes, requires Ollama), `knowledge_search` (deterministic ranked search over notes + remembered facts/preferences, no model required), `user_model_read` (facts/preferences with confidence, never vetoed/forgotten entries). No `--local` needed — self-contained, doesn't need the API server. Live-verified via `apps/cli/scripts/verify-mcp-serve-grounding.mjs`: seeded-note question answered with citation `[from vpn.md]`, absent-info question honestly refused with zero citations.

### config / config-path — CLI config ✅ ran
- `config-path` → `/Users/jinan/.config/muse/config.json`. `config show` → `apiUrl=` + `defaultModel=ollama/qwen3:8b`. Subcmds: `show / set / unset`.
- ⚠️ **DRIFT**: `config show` reports `defaultModel=ollama/qwen3:8b` but `doctor` + `status` report effective default `ollama/gemma4:12b`. The stored config value is stale qwen3:8b; the runtime ignores it (local-only default = gemma4:12b). Cosmetic but confusing.

### status — JARVIS dashboard ✅ ran
- persona + model + imminent tasks + last notice. `--user`, `--json`, `--suggestions`, `--watch`, `--interval`.
- Evidence ran: showed user jinan, model `ollama/gemma4:12b (inferred from GEMINI_API_KEY)`, 31 open tasks, followups/reminders counts, rag indexed (nomic-embed-text-v2-moe), notifications log path.
- ⚠️ minor: "inferred from GEMINI_API_KEY" wording on status while local-only is on (model is gemma4:12b local; the inference label is misleading but harmless).

### completion — shell completion ✅ ran
- `muse completion <bash|zsh>`. Ran `completion zsh` → valid `#compdef muse` zsh script.

### onboard — guided setup ✅ help
- "single next step to your first private, cited answer". `--json`. Sibling of `setup wizard`.

### auth — CLI credentials ✅ help
- Subcmds: `login [token]` (encrypted store), `status`, `logout`, `rotate-jwt` (fresh JWT signing secret + grace-window old). Backed by `@muse/auth` (`jwt.ts`, `user-stores.ts`).

### setup — survey/configure ✅ help
- Subcmds: `status`, `calendar`, `messaging`, `model` (gemini/openai/anthropic/openrouter/ollama/groq/deepseek/together/mistral/moonshot/cerebras), `wizard` (model→calendar→messaging), `local` (wire Ollama, no key), `voice` (probe whisper.cpp + piper). NOTE: `setup local` is the real subcommand; **`setup-local` (hyphenated top-level) is NOT a command** — it fell through to top-level help.

### loopback — loopback MCP catalog ✅ help ⬜ live
- `GET /api/muse/loopback` — catalog of loopback MCP servers. ⚠️ no `--local`; server-only live.

### snapshot — admin observability snapshot ✅ help ⬜ live
- `GET /api/admin/muse/snapshot` — latency, token cost, SLO, drift, cost, budgets, follow-ups. Backed by `createMuseObservabilitySnapshotProvider` (fail-soft: each component try/catch, omitted if dep absent).

### export / import — backup ✅ help (NOT run — writes)
- `export`: bundle every `~/.muse/*.json` store + notes tree → timestamped `.tar.gz`; `--encrypt` AES-256-GCM (passphrase via `$MUSE_EXPORT_PASSPHRASE` or prompt, `.enc` suffix); `--output`.
- `import <bundle>`: restore into `~/.muse/`; `--force` (overwrite), `--dry-run`, `--decrypt` (auto-detects `.enc`). Refuses overwrite without `--force`.

### job — background tasks ✅ help
- Subcmds: `run <prompt>` (returns job id, streams to `~/.muse/jobs/<id>.jsonl`), `status <id>`, `list`, `tail <id>`, `delete <id>`. NOTE: `jobs` (plural top-level) is NOT a command (falls through to top help); the command is `job`.

---

## 2. apps/api — HTTP route groups (26 registered in server)

Registered via `register*Routes` (server.ts / server-routes.ts):
1. CoreRoutes  2. ChatRoutes  3. AuthRoutes  4. AdminRoutes  5. AdminRunRoutes
6. AgentSpecRoutes  7. AgentNoticesRoutes  8. ActiveContextRoutes  9. AccountabilityRoutes
10. CalendarRoutes  11. RemindersRoutes  12. TasksRoutes  13. TodayRoutes  14. NotesRoutes
15. McpRoutes  16. MessagingRoutes  17. MultiAgentRoutes  18. ProactiveRoutes
19. RuntimeSettingsRoutes  20. SchedulerRoutes  21. SessionSummaryRoutes  22. SetupRoutes
23. ToolsRoutes  24. VoiceRoutes  25. HistoryRoutes  26. CompatibilityRoutes (umbrella).

Compat shim route fns (under the compatibility umbrella): AdminAnalyticsCompat, AdminObservabilityCompat, AdminPlatformCompat, AdminSessionCompat, AgentCompatibility, AuthCompatibility, McpCompatibility, SessionCompatibility, UserMemoryCompat.

Background "tick" daemons (not HTTP routes — scheduled in-process): ambient-tick, channel-poll-tick, consolidate-tick, discord/slack/telegram-poll-tick, followup-tick, inbound-reply-tick, objectives-tick, pattern-tick, proactive-tick, reminder-tick, situational-briefing-tick, web-watch-tick, os-idle/power-state (resolved via `tick-daemons.ts`). 🧪 tick-daemons-resolve.test.ts.

107 files in apps/api/src (many `*.test.ts` co-located — strong test coverage).

---

## 3. apps/web — React UI panels (14 views)

Activity, Autonomy, Calendar, Chat, Dashboard, Memory, Messaging, Notes, Reminders, Settings, Tasks, Today, Tools. (`Dashboard` + `Today` are the two ops/at-a-glance panels; `Tools` mirrors CLI tool stats; `Autonomy` = autonomous actions review.)
Plus shell: App.tsx (router/sidebar), CommandPalette, NoticeToaster, i18n (LangToggle), api/client + useChatStream/useNoticeStream/useVoice. 🧪 many co-located `.test.tsx` (CommandPalette a11y, SidebarNav, Calendar, Tasks, Today, Memory).
README says "React UI (chat + tasks + calendar + settings)" — UNDERSTATED (14 panels incl. Dashboard/Autonomy/Activity/Memory/Messaging/Reminders/Notes/Tools).

---

## 4. apps/desktop — native macOS companion ⬜ code-only (Swift, not run)

SwiftPM package (`Package.swift`), built `MuseDesktop.app`. Two targets:
- `MuseDesktopCore` (testable logic): SpeakerSelection, Localization, Sprite, AnswerPresentation, HexColor, OllamaHealth, CompanionPrefs, SpriteLibrary, VoiceGate, MuseSprite, MuseBridge. 🧪 6 test files (AppLanguage, MuseBridge, HexColor, SpeakerSelection, OllamaHealth, Presentation).
- `MuseDesktop` (app/UI): MuseController, FloatingPanel (NSPanel), GlobalHotKey, SpriteRenderer, VoiceOrb, WhisperCapture, CompanionView/Model, main.swift. Floating draggable pixel-Muse, click-to-talk, hotkey, whisper STT — matches MEMORY `project_desktop_companion`.
- `scripts/build-cli-binary.mjs` + `make-app.sh` bundle the CLI binary.

---

## 5. crates/runner — Rust sandbox ⬜ code-only (309 LOC, not built)

`muse-runner` v0.0.0, edition 2021, deps serde + serde_json only. Single `main.rs`.
- Reads ONE JSON `RunnerRequest` (command, args, cwd, env, timeoutMs, maxOutputBytes) from stdin, writes ONE `RunnerResponse` (ok, status, stdout, stderr, timedOut, truncated, error) to stdout.
- Hard limits: DEFAULT_TIMEOUT_MS=30_000, DEFAULT_MAX_OUTPUT_BYTES=64KiB. Stdin null'd to child. **Refuses path-bearing commands** (`command.contains('/')` → error "must be an executable name, not a path") — fail-close. Blank command refused. This is the "risky local execution flows through crates/runner" boundary.

---

## 6. Package inventory (one-line each; @muse/* scope)

| Package | Role |
|---|---|
| observability | Tracing pipeline, latency/token-cost queries, SLO-alert evaluator, prompt-drift detector, monthly budget tracker, JARVIS observability snapshot provider |
| db | Kysely schema (18 tables) + SQL migrations (`migrations.ts`, 2 named) — Postgres source of truth |
| auth | JWT signing/verify (`jwt.ts`), user stores, AuthError; backs `auth rotate-jwt` + bearer tokens |
| cache | (single `index.ts`) cache primitive |
| resilience | (single `index.ts`) retry/backoff/circuit primitives |
| runtime-state | run history, hook traces, debug-replay captures, session tags, Kysely stores |
| runtime-settings | runtime settings store (Kysely) for `settings` command + live refresh |
| shared | shared utilities + byte-hygiene gate (no raw control bytes) |
| browser | real-Chrome control via Puppeteer — controller + matcher + `browser-tools.ts` (draft-first approval gate) |
| autoconfigure | the big wiring package: `createMuseRuntimeAssembly`, store factories, tracing pipeline, loopback-tools, mcp-stack, official-mcp posture/credentials, embedder, provider paths, knowledge sources |
| macos | macOS tools: app open/read, media, screen, shortcut, system-set, glance — `muse glance`/`home` etc. |

(Out-of-domain packages also present: a2a, agent-core, agent-specs, calendar, mcp, memory, messaging, model, multi-agent, policy, prompts, recall, scheduler, skills, tools, voice.)
NOTE: cache/resilience/shared/runtime-settings each have NO `description` in package.json (empty) and are single-file — thin/utility packages.

---

## 7. Observability internals (verified via codegraph source read)

- **MonthlyBudgetTracker** (`budget-tracker.ts`): rolls over on UTC month, ok/warning/exceeded vs cap; validates non-negative limit + 1–100 warningPct; non-finite/negative cost ignored; snapshot emits remainingUsd/percentUsed only when limit>0.
- **TokenCostQuery** (`observability-token-cost.ts`): InMemory + Kysely impls over `metric_token_usage`; `bySession`/`daily`/`topExpensive`. Cost-tie fallback to token volume + runId tiebreaker (handles Qwen-only $0 setups — deterministic ordering).
- **SloAlertEvaluator** (`observability-slo-alert.ts`): sliding-window p95 latency + error-rate violations, cooldown + minSamples, own percentile helper.
- **PromptDriftDetector** (`observability-prompt-drift.ts`) + **agent-metrics** + **tracers**. 🧪 prompt-drift.test, slo-alert.test.
- **createMuseObservabilitySnapshotProvider** (`observability-muse-snapshot.ts`): aggregates latency+tokenCost+slo+drift+budget+followups; each component fail-soft (try/catch + logger), section omitted if dep absent — safe for partial runtime + `/api/admin/muse/snapshot`.

---

## 8. DB schema (18 tables) — `packages/db/src/schema.ts`

Compatibility, AgentRun, AgentSpec, Checkpoint, ConversationMessage, ConversationSummary, DebugReplayCapture, HookTrace, McpSecurityPolicy, McpServer, MetricTokenUsage, RuntimeSetting, ScheduledJob, ScheduledJobExecution, ScheduledJobLock, SessionTag, ToolCall, TraceEvent, UserMemory, User.
Migrations: `0001_runtime_state`, `0002_conversation_summaries_user_id`.

---

## 9. Verification-gate inventory (which pnpm script proves what)

Smoke: `smoke:broad` (diagnostic HTTP sweep, no key), `smoke:live` (real LLM round-trip, LOCAL OLLAMA ONLY), `smoke:live:all`, `smoke:binary`, `smoke:browser`, `smoke:cli`, `smoke:diagnostic`.
Evals (LOCAL OLLAMA ONLY, skip if unreachable): `eval:tools`(+`:nl`) tool-selection+args+irrelevance; `eval:agent` bundle; `eval:adversarial` must-refuse+over-refusal; `eval:judge` LLM-judge meta-eval; `eval:plan-quality`; `eval:self-improving` (pattern/preference/skill/playbook merge); `eval:shadow-trial`; `eval:vision`(+`-agent`/`-grounding`); `eval:grounding-delta`(+`squad`); `eval:browser-agent`; `eval:memory-poisoning`; `eval:action-log-tamper`; `eval:consent-fail-close`; `eval:recipient-resolution`; `eval:policy-symmetry`; `eval:conformal-tools`; `eval:embedder-ab`; `eval:reasoning-efficacy`; `eval:receipt-drift`; `eval:chat-grounding`; `eval:file-read`; `eval:explore`; `eval:differentiation`; `eval:orchestration`; `eval:tool-arg-grounding`.
Other gates: `check` (build+test all workspaces), `lint`/`lint:fix` (11 rules @error), `self-eval`(+`--full`/`:test`) regression scoreboard, `check:capabilities` drift guard.
Scripts present in `scripts/`: eval-harness.mjs (runEvalSuite+scorers+llmJudge+runShadowTrial), guard-immutable.mjs, guard-writeback.mjs, reflection-guard.test.mjs, eval-semantic-entropy.mjs, verify-file-read.mjs, verify-orchestration.mjs, smoke-broad-http.mjs, smoke-cli(-binary).mjs, pick-evals.mjs.

---

## 10. DOC DRIFT (recorded — most FIXED 2026-06-14, see INDEX §4)

1. ✅ FIXED — Node version: README now "Node.js >= 22.12 (24 LTS recommended)", matching `package.json` engines `>=22.12.0`.
2. ✅ FIXED — muse.* server count: README now "~24" (the earlier "27" wrongly counted `notes-multi`/`tasks-multi` variants + a phantom `muse.png`; canonical = 24).
3. **Still note** — "three personal-pivot loopback MCP servers" (README's notes/tasks/calendar trio) is the personal-pivot subset, not the full ~24 loopback catalog; wording could be clearer.
4. **Still true (not a doc bug)** — stored `~/.config/muse/config.json` may hold `ollama/qwen3:8b`, but under local-only the runtime ignores it and uses `ollama/gemma4:12b` (doctor/status show gemma4). `config show` surfaces the stale stored value.
5. ✅ FIXED — README package list now enumerates all 27 packages (was truncated with `...`).
6. ✅ FIXED — apps/web now listed as 13 panels with names (was "chat+tasks+calendar+settings"; the real count is **13**, not the 14 this report first stated).
7. **Still note** — `jobs` (plural) and `setup-local` (hyphenated) are NOT commands; the real ones are `job` and `setup local`. Any doc using `muse jobs`/`muse setup-local` is wrong.

## 11. BROKEN / SUSPECT

- No broken code found. The "broken" surfaces are server-gated (cost/tools/mcp list/settings/metrics/latency/traces/telemetry/analytics need the API server and have no `--local`) — expected, not a bug, but means these admin observability commands are UNVERIFIABLE without starting the daemon (out of scope for read-only). Live-verified set: doctor, privacy, status, config(-path), completion, onboard help, all --help.
- `status` model label "inferred from GEMINI_API_KEY" is misleading under local-only (the effective model is local gemma4:12b); cosmetic.
