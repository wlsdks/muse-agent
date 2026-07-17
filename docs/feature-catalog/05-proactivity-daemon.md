# Domain 05 — Proactivity / Daemon / Sessions / Accountability

> Proactivity is an Attunement delivery substrate, not the closed loop. This snapshot does
> not prove observation → rhythm → friction → outcome adaptation. See the
> [Attunement roadmap](../goals/attunement-implementation-plan.md).

Catalogued 2026-06-14 against `main` (HEAD 2828a04b). CLI built (`apps/cli/dist/index.js`, 2026-06-13).
Verification: `node apps/cli/dist/index.js <cmd> --help </dev/null` for every command + read-only live runs.
NO daemon/server/webhook listener was started, no sends, no cloud calls.

Legend: ✅ ran live · 🧪 covered by tests · ⬜ code-only (read) · ⚠️ broken/suspicious · 🤖 needs-model

---

## A. Background daemon (the resident process)

### `muse daemon` — one-process resident daemon ✅🧪
- **What**: Runs every enabled proactive sub-tick in a single process. `--once` runs one tick of each then exits; `--status` prints readiness; `--init` persists provider/destination to `~/.config/muse/daemon.json`; `--install` writes a macOS LaunchAgent plist (survives logout/reboot); `--interval` (5–86400s, default 60), `--lead-minutes` (1–1440, default 10), `--provider` (default env→config→`log`), `--destination` (default `@me`), `--print` echoes each delivered notice to stdout.
- **Enabled sub-ticks** (from `daemon --status`, all default to `log`/`@me`): proactive, reminders, followup, **objectives** — all `enabled`; ambient, web-watch, home-watch, briefing, self-learn, recap, email-sync, msg-poll, conflicts — all `disabled` behind env flags.
- **Evidence**: `daemon --status` ran (exit 0) and listed every tick + its source file path + autostart status. `commands-daemon.ts:registerDaemonCommands` (apps/cli) + `commands-daemon-config.ts` + `commands-daemon-launchagent.ts`. Tests: `commands-daemon.test.ts`, `commands-daemon-config.test.ts`.
- **`--once` safety note**: NOT run. `--once` fires a single tick of EACH enabled daemon and may deliver via the configured messaging provider; with default `log` provider that writes to the log sink (no external egress), but I treated it as a potential delivery and did not invoke it per the read-only constraint. Source confirms it is bounded/non-blocking (clamped interval, single-flight `firing` guard, `setInterval(...).unref()`).
- **Doc drift**: SYSTEM-MAP/FEATURES describe earned-proactivity/quiet-hours/check-ins but do NOT document the `muse daemon` command surface or its `--status/--init/--install` flags. (`daemon --status` prints **13 readiness lines**; `runTick` actually executes **19** ticks — the extra silent/throttled ones are checkins, pattern, reflection, selfLearnDecay, playbookConsolidate, memoryConsolidate.) ⚠️ moderate drift.

### API-side ticks (server-resident equivalents) ⬜🧪
- `apps/api/src/tick-daemons.ts` is the aggregator: `startReminderDaemonIfConfigured`, `startProactiveDaemonIfConfigured`, `startObjectivesDaemonIfConfigured`, plus ambient / web-watch / home-watch / pattern / situational-briefing / inbound-reply / messaging-poll ticks. Each `start*Tick` (e.g. `proactive-tick.ts`, `objectives-tick.ts`, `followup-tick.ts`, `reminder-tick.ts`, `pattern-tick.ts`) is a `setInterval` rider: default 60_000ms, clamped [5s, 1h], single-flight `firing` guard, `.unref()`, fail-soft (catches + logs), and gated by `quietHours`.
- Every tick is OFF unless its `MUSE_*_PROVIDER`/`DESTINATION` env (+ a signal source) is configured. Server + CLI daemon share `@muse/mcp` loop primitives — same guard semantics.

---

## B. Proactive notice engine (the surfacing core)

### Proactive surfacing loop — `runDueProactiveNotices` ⬜🧪
- **What**: Each tick finds imminent calendar events + due-soon tasks (lead window), dedupes against the fired ledger, optionally synthesizes a one-line LLM heads-up (Phase D), delivers via messaging provider (and optionally a terminal sink / agent-notice broker), and records to history + trust ledger. `packages/mcp/src/proactive-notice-loop.ts`.
- **Phase A** = calendar, **Phase B** = tasks, **Phase D** = agent-initiated LLM-composed turn delivered inline to a live chat (only when user seen within `activeSessionWindowMs`, default 5 min). `PHASE_D_SYSTEM_PROMPT` synthesizes via `modelProvider.generate` (preferred, no tools) or `agentRuntime`; defensive fallback to flat text if the small model emits tool-call JSON. 🤖 LLM-path.
- **Dedupe**: `proactive-notice-store.ts` — `~/.muse/proactive-fired.json`, key = `${kind}:${id}` + `startIso` (a moved meeting re-fires). FIFO trim 1000.

### `muse proactive` utility surface ✅🧪
Subcommands (verified via `--help` + live runs):
- `proactive scan` ✅ — dry-run of what would fire next tick. Ran: printed the 10-min window, "no imminent events / no due-soon tasks".
- `proactive watch` ⬜ — foreground daemon loop (long-running; NOT run). Has `--ignore-routine` (otherwise routine_active_hours/quiet-hours suppress), `--speak` (TTS).
- `proactive test` ⬜ — sends one test line to `MUSE_PROACTIVE_PROVIDER/DESTINATION`. NOT run (it sends).
- `proactive history` ✅ — audit `~/.muse/proactive-history.json`. Ran: "No proactive history yet".
- `proactive done` / `snooze <dur>` / `dismiss` ⬜ — act on the most-recent notice's task (NOT run; mutate).
- `proactive scoreboard | veto | keep | acted` ✅ — the **trust scoreboard** (see C). `scoreboard` ran live.
- **Evidence**: `commands-proactive.ts` + `chat-proactive.ts`. Tests: `commands-proactive.test.ts`, `chat-proactive.test.ts`.

### In-chat proactivity ("speaks-first") ⬜🧪
- `apps/cli/src/chat-proactive.ts` — pure helpers that decide what's imminent/new/how-phrased for the in-chat surface. Sources surfaced inline: due tasks, calendar events, **due check-ins**, **fireable patterns**, **completed background jobs**. `groupProactiveNotice` collapses several due things into ONE line (not a wall of notices). `imminentItems` (lead window + 2-min grace), `pickUnseen` (seen-set dedupe per session). All titles run through `stripUntrustedTerminalChars`.
- `proactive-notes-recall.ts` — wires confidence-gated cited recall (CRAG `decideProactiveRecall`) into the local daemon's `investigate` seam: surfaces a cited finding from the user's own notes ONLY when recall is confident; fail-open otherwise. (Grounding floor under proactivity.)
- Tests: `chat-proactive.test.ts`, `proactive-notes-recall.test.ts`, `proactive-terminal-sink.test.ts`.

---

## C. Earned proactivity + trust gate (the "earned it" machinery)

### Earned-proactivity persistence gate — `selectEarnedThemes` ⬜🧪
- **What**: A theme earns a proactive nudge only after it PERSISTS — seen across ≥ `minSources` (default 2) independent sources, ≥ `minOccurrences` (default 3) times, spanning ≥ `minDwellDays` (default 2), last seen within `activeWithinDays` (default 14). A single fleeting mention is filtered as noise. Modeled on the coherent type-1 feed-forward loop (Mangan & Alon 2003). Deterministic; only scores PAST occurrences (future calendar items are plans, not evidence). `packages/agent-core/src/earned-proactivity.ts`.
- **Evidence**: read in full. Decides WHEN it's earned, never WHAT to say (grounding floor governs the message).

### Proactive trust ledger / scoreboard ✅🧪
- **What**: `proactive-trust-ledger.ts` (`@muse/mcp`) records every surfaced notice (`appendSurfaced`) and the user's verdict (`recordOutcome`: `acted`/`kept`/`vetoed`). `computeTrustScore` → precision = fraction NOT vetoed (the "did proactivity earn its place" number). A pre-emptive veto on a never-surfaced source is `recordedWithoutSurface` and excluded from precision math. `~/.muse/proactive-trust.json`, atomic+fsync write via shared `atomic-file-store`, per-file mutation queue, FIFO trim 2000.
- **Evidence**: `proactive scoreboard` ran live — printed "Surfaced: 2000 Kept:0 Acted:0 Vetoed:0 Precision: 100%" + recent surfaces (test-seeded data present). `vetoed` = learned avoidance (source silenced going forward).
- **Tests**: `proactive-trust-ledger.test.ts`.

### Quiet hours / DND — `quiet-hours.ts` ⬜🧪
- **What**: `parseQuietHours` reads `MUSE_PROACTIVE_QUIET_HOURS` / `MUSE_REMINDER_QUIET_HOURS` (`22-7` or `22:00-07:00`, hour-granular, wraps midnight). `isQuietHour` checks the window; `gateProactiveNoticeSink` wraps a sink so ambient/awareness notices are suppressed during the window. Malformed input → `undefined` (fail to "always allowed", not silent self-disable). User-scheduled reminders/followups fire on their OWN path (urgent "pay rent" unaffected).
- **Evidence**: read in full. Used by both API ticks and CLI daemon (shared window). `proactive watch --ignore-routine` flag overrides routine quiet hours.

### Routine / active hours — `muse routine` ✅
- **What**: Aggregates `~/.muse/activity.jsonl` into `routine.active_hours` + `topDays`; `--apply` writes the fact to user-memory (gates when notices may fire). `--days` window (default 30), `--user`, `--json`.
- **Evidence**: ran live — "sessions: 5 across 1 day, top active hours: 19,03,18, top active days: Sun,Mon".

### Learned avoidance (veto) ⬜🧪
- `veto-avoidance.ts` (agent-core) injects a bounded `[Learned Avoidance]` soft-prompt block (≤ N vetoes; deterministic gate still enforces ALL). `personal-veto-store.ts` (`recordVeto`/`hasVeto`) is the authoritative store. Pattern dismissals are a distinct learned-avoidance path (see D). Tests: `personal-veto-store.test.ts`.

---

## D. Pattern detection → suggestion

### Pattern detector + fired/cooldown store ⬜🧪
- **What**: `@muse/memory` `pattern-detector.ts` / `pattern-orchestration.ts` detect time-of-day + weekly-task patterns (sha256-12 `patternId`). `personal-patterns-fired-store.ts` (`~/.muse/patterns-fired.json`) is the cooldown sidecar: `recordPatternFired`, `isPatternOnCooldown` (newest fire wins), `dismissPattern` + `isPatternDismissed` (learned avoidance — dismissed patterns NEVER fire again, surviving a cooldown reset). Atomic write, per-file mutation queue.
- **Surfacing**: `patternSuggestionItems` (chat-proactive) renders the detector's verbatim suggestion as a `💡` in-chat item. `pattern-suggestion.ts` (agent-core) + `pattern-tick.ts` (api).
- **CLI**: `muse pattern` (audit + cooldown management — adjacent, lightly in scope).

---

## E. Check-ins (proactive nudges on commitments)

### `muse checkins` ✅🧪
- **What**: `checkins scan` reads recent chat for commitments and schedules due-windowed next-day check-ins (`--slot-hour` default 10, `--max-per-day` default 3). `checkins list` ✅ (ran: "No scheduled check-ins"). `cancel <id>`, `snooze <id> <when>` (NL time). The daemon's `runDueCheckins` (`commitment-checkin.ts`) fires due ones to the user's OWN channel only (never third-party), honoring quiet hours (DND gates the whole tick), `maxPerTick` default 5, and patches only fired ids under a mutation queue (a concurrent cancel is preserved, a cancelled nudge is never resurrected).
- **Evidence**: `checkins list` ran live. `commitment-detector.ts` (agent-core) detects commitments. Tests: `commands-checkins.test.ts`.
- **Doc**: FEATURES.md line 89 ✅ documents this accurately (incl. session-end auto-scan opt-in, in-chat surfacing).

---

## F. Standing objectives (delegated autonomy)

### `muse objectives` ✅🧪
- **What**: Register "watch X / until Z / tell me when W" objectives the daemon re-evaluates autonomously. `objectives add <spec> --kind watch|until|notify` (default `until`), `list --status active|done|escalated|cancelled|all` ✅, `cancel <id>` (gave up), `done <id>` (achieved). `--user` owner bucket.
- **Evidence**: `objectives list` ran live ("No objectives"). Store: `personal-objectives-store.ts`. Loop: `objective-evaluation-loop.ts` `runDueObjectives` + `objectives-tick.ts` (api). Tests: `commands-objectives.test.ts`, `personal-objectives-store.test.ts`, `objective-evaluator.test.ts`.

### Outbound safety: consent gate + draft-first actuator ⬜🧪 (SAFETY-CRITICAL)
- **`performConsentedAction`** (`consented-action.ts`): an objective may perform an external HTTP action with a scoped credential ONLY when consent is RECORDED for that exact `{objective, scope}`. Fail-closed + deterministic: no consent ⇒ no HTTP call, ever. A matching **veto overrides prior consent** (checked first). Credential is bound to `consent.allowedHost` (fail-closed on host mismatch or unparseable URL → token never leaves — credential-exfil guard). Caller-supplied `authorization` header stripped. 30s timeout cap. Transport injected (`fetchImpl`) — tested over a real request shape, never a fake "did it" flag.
- **Two actuators** (`objective-evaluator.ts`): `createMessagingObjectiveActuator` notifies the user's OWN channel ("✅ Objective met") + logs to action log (low-risk reply-to-user). `createProposingObjectiveActuator` for third-party-bound notifications PROPOSES a pending action (draft-first) instead of sending — user confirms via `muse propose approve`. This is `outbound-safety.md` as code.
- **Tests**: `consented-action.test.ts`, `personal-consent-store.test.ts`, `objective-evaluator.test.ts`.

---

## G. Draft-first proposals (the outbound gate surface)

### `muse propose` ✅🧪
- **What**: Review/confirm actions Muse proposed; nothing sends until approved. `propose list` ✅ (ran: "No proposed actions awaiting confirmation"), `approve <id>` (executes the draft exactly ONCE → `executed`), `decline <id>` (→ `declined` + a veto so the class stops re-proposing).
- **Store**: `personal-proposed-action-store.ts` — `pending|executed|declined`, `expiresAt` TTL default 24h (`isProposalActionable` = pending AND not expired; an expired proposal is inert — outbound-safety's "approval times out → no action"). Atomic+fsync write, per-file mutation queue (approve/decline patch-by-id never clobbered). Only `message` kind today.
- **Tests**: `commands-propose.test.ts`.

### `muse approvals` ✅🧪 (channel-approval pending worklist)
- **What**: Review or durably deny channel actions awaiting approval (the LIVE pending worklist, distinct from `propose`). `approvals list` shows unexpired pending ids. `approve <id>` claims the exact stored draft before execution, records `succeeded | unknown`, and blocks every replay; `clear <id>` records a durable `denied` tombstone. `status <id>` shows redacted durable state. `recover <id>` explicitly takes over an eligible stale pre-effect claim for the existing local `muse.tasks.add` or `muse.tasks.complete` tool. A channel "yes" only returns the CLI command for that id and never executes the action itself.
- **Safety**: API and CLI call one provider-neutral `@muse/messaging` coordinator; they do not reproduce claim/begin/finalize or outcome logic. The coordinator uses the shared claim/CAS store and negative-first classifier, runs an effect-bearing callback only after begin wins, distinguishes CAS loss from persistence uncertainty, and observes the durable state when possible. Recovery requires the same owner, an unexpired immutable snapshot, and a fixed 15-minute stale-claim lease; it rotates the old token before preparation and never retries executing or terminal work. Public status omits tokens, arguments, internal actors, and paths. The boundary is at-most-once: a post-claim crash can omit an effect, but the id cannot execute twice. Tombstones are not pruned automatically in this slice.
- Adjacent: `muse approval` (singular) = pending tool-call approvals audit+decide (overlaps the approvals/guard domain). Tests: `commands-approvals.test.ts`, `commands-approval.test.ts`.

### `muse autonomy` ✅🧪 (progressive-autonomy evidence)
- **What**: Issue/list/revoke an exact bounded local next-step grant, record shadow opportunities, review or decide unresolved organic evidence, and report readiness. CLI Ink reuses an explicit `y`/`n` answer for the exact `muse.tasks.complete` opportunity instead of asking for the same preference again.
- **Safety**: Runtime evidence is CLI-only, explicit-user-only, exact run/call/owner bound, and revalidates the current user-authored link plus open task before recording. Cancel, automatic policy/trust decisions, stale or unreadable sources, API/channel approvals, and missing correlations write nothing. Manual and runtime evidence are mutually exclusive, never issue permission, and reaching the sample threshold still requires an independent audit and explicit promotion decision.

---

## H. Accountability: action log + undo

### `muse actions` — the accountability log ✅🧪
- **What**: Review what Muse did autonomously (or refused). Filters `--result performed|refused|failed|all`, `--user` (or `all`), `--limit`. **`--verify`** checks a tamper-evident hash-chain (each entry's `prevHash` binds to all prior history — a deletion/edit/reorder breaks verification at a precise index). Encryption-at-rest: `encrypt`/`decrypt`/`encryption-status` subcommands (AES-256-GCM, key = `MUSE_MEMORY_KEY` or per-host).
- **Evidence (ran live)**: `actions --limit 5` → showed a `[refused]` "declined proposal … not sent" entry; `actions --verify` → "✓ chain intact — 3979 linked entries verified"; `actions encryption-status` → "plaintext (~/.muse/action-log.json)".
- **Store**: `personal-action-log-store.ts` — `appendActionLog` (chained, serialized append queue), `queryActionLog` (newest-first by parsed instant), `verifyActionLogChainFile`. Result enum `performed|refused|failed`. Tests: `personal-action-log-store.test.ts`, `commands-actions.test.ts`.

### Undo + veto — `undoLoggedAction` ⬜🧪
- **What**: Reverses a logged action where reversible (injected `reverse()`), ALWAYS records a veto (`veto_${objectiveId}_${scope}`) so the class can't recur (learned avoidance), and appends an `undo_*` action-log entry. Irreversible action → veto still recorded ("irreversible — veto recorded so it cannot recur"). `packages/mcp/src/undo-action.ts`.
- **Tests**: `undo-action.test.ts`.
- **Doc**: FEATURES.md line 157 ✅ documents accountability+undo+learned-avoidance accurately.

---

## I. Sessions / Focus-DND

### `muse session` ✅🧪
- **What**: Focus / Do-Not-Disturb controls for proactive notices. `session lock --hours/--minutes [--reason]` (pause until elapsed, default 1h), `session unlock` (resume immediately), `session status` ✅ (ran: "session unlocked").
- **Store**: `~/.muse/session-lock.json` (`writeSessionLock`/`readSessionLock` in proactive-notice-store.ts) — atomic 0o600 write, fail-OPEN read (a corrupt marker can't permanently silence the daemon). `runDueProactiveNotices` reads it each tick and reports `sessionLockedUntil` + skips firing. Optional `reason` surfaced in `session status` + daemon log.
- **Tests**: `commands-session.test.ts`.
- **Note on "Sessions"**: This domain's "session" = the DND lock ONLY. The broader continuous-companion session model (recap / `/memory` / episodes) lives in other domains; `muse episode` is the prior-session summary surface (adjacent).

---

## J. External-signal triggers

### `muse watch-folder` ⬜🧪
- **What**: Watch a folder (default `~/.muse/inbox`) for new files and fire each as a proactive notice — credential-free external trigger. `--as-task` (creates a tracked task per file so the daemon picks it up; `--default-lead-minutes` default 60 when no due:/마감: line), `--ingest` (ingest each new file INTO the notes corpus as a citable `.md` instead of firing a notice; `--notes-prefix` default `inbox`), `--provider`/`--destination`. NOT run (long-running watcher).
- **Tests**: `commands-watch-folder.test.ts`.

### `muse webhook serve` ⬜🧪
- **What**: Loopback HTTP server — `POST /notify` body → proactive notice (+ optional task with `--as-task`). `--port` default 7777, **`--host` default 127.0.0.1 (local-only, not exposed beyond the machine)**, `--provider`/`--destination`. NOT run (long-running listener). Source confirms loopback bind by default.
- **Tests**: `commands-webhook.test.ts`. (Distinct from `apps/api/messaging-webhooks-routes.ts` = inbound messaging webhooks.)

### `muse agent-notices tail` ⬜🧪
- **What**: Stream agent-initiated heads-ups (Phase D) for this user until Ctrl-C (`--user`, `--json`). Consumes the API SSE endpoint `GET /api/agent-notices/stream?userId=` (`agent-notices-routes.ts`), backed by the in-process `InMemoryAgentInitiatedNoticeBroker` (`agent-core/agent-initiated-notice.ts`): per-subscriber queue cap (default 16, oldest dropped on overflow), dropped-count diagnostic, fan-out to all subscribers of a userId, unsubscribe on disconnect (in-flight drain stops). NOT run (streaming).
- **Tests**: `commands-agent-notices.test.ts`.

### `muse feeds` — RSS/Atom ambient world-state ✅🧪
- **What**: `feeds add <url>` (fetch-once on add), `list` ✅ (ran: "no feeds"), `remove <id>`, `refresh [--id]`, `today` ✅ (ran: "no entries in last 24h"), `search <query>` (whole cached archive). Feeds ambient signal into proactivity. `feeds-store.ts`, `feed-dedupe.ts`, `brief-feeds.ts`. Tests: `commands-feeds.test.ts`, `feeds-store.test.ts`, `feed-dedupe.test.ts`, `brief-feeds.test.ts`.

---

## K. Unified activity views (read surfaces)

### `muse history` ✅ + `muse open` ⬜
- `history` ✅ — unified feed across reminder/proactive/followup/pattern/episode stores, newest first. `--kind`, `--since`, `--limit` (cap 200), `--grep`+`--case-sensitive`, `--json`. Ran: showed 3 followup entries.
- `open <prefix>` ⬜ — look up an activity record by ID prefix across every store (first hit wins, ambiguous surfaced); `--json`/`--raw`. Tests: `commands-history.test.ts`, `commands-open.test.ts`.

### `muse today` ✅ (proactive side)
- Morning briefing — open tasks + next-24h calendar + recent notes. `--brief` (NL summary via model 🤖), `--speak` (TTS), `--connect` (related past notes/sessions), `--local`, `--json`. Adjacent helpers: `today-stale-revisit.ts` (stale-task + episode-revisit), `today-feeds`/`commands-today-feeds.ts`. Tests: `commands-today.test.ts`, `today-stale-revisit.test.ts`, `commands-today-api-warn.test.ts`.

---

## BROKEN / SUSPICIOUS

1. ⚠️ **`muse proactive-trust` is NOT a command** — `node …/index.js proactive-trust --help` falls back to ROOT help, and `proactive-trust` (no --help) errors: `error: unknown command 'proactive-trust'`. The brief lists it as a command but the real surface is `registerProactiveTrustSubcommands` adding `scoreboard`/`veto`/`keep`/`acted` UNDER `muse proactive`. The file `commands-proactive-trust.ts` + `commands-proactive-trust.test.ts` exist but only register SUBcommands. This is a naming trap, not a code bug — but any doc that says `muse proactive-trust …` would be wrong. (No drift in current docs — they don't mention it.)
2. ⚠️ **Trust scoreboard shows test-seeded data** in the live store (`~/.muse/proactive-trust.json`: 2000 entries, many `task:t1 "Ship the memo"` from 12:31/12:44 today). Not a code bug — it's a dev/test machine artifact (tests writing to the real home store). Worth noting for anyone reading the live scoreboard as "real usage".
3. ℹ️ **`daemon --once` not exercised** (constraint-safe): it can deliver via the messaging provider, so I captured `--status` instead. The static read confirms it is bounded + single-flight; treat "fires a single tick" as code-verified, not run-verified.

---

## DOC DRIFT (vs docs/FEATURES.md, docs/SYSTEM-MAP.md, README.md)

- **Accurate ✅**: earned-proactivity (FEATURES 148, SYSTEM-MAP 147), quiet-hours/DND (FEATURES 149), check-ins (FEATURES 89), standing objectives + consent fail-close (now FEATURES :167, marked ✅ as of 2026-06-14), accountability+undo+learned-avoidance (FEATURES 157). These match the code well.
- **MISSING from docs ⚠️**: No documentation of the **`muse daemon` command** itself (`--status/--init/--install/--once`, its ticks — 13 readiness lines / 19 actual ticks, LaunchAgent autostart). No docs for **`muse watch-folder`**, **`muse webhook serve`**, **`muse agent-notices tail`** (external-signal triggers / Phase D SSE stream). No docs for the **proactive trust scoreboard** CLI (`muse proactive scoreboard/veto/keep/acted`) or **`muse propose`** / **`muse approvals`** draft-first surfaces. No docs for **`muse feeds`** ambient world-state, **`muse routine`**, **`muse history`/`open`**, or the **action-log hash-chain `--verify`** + encryption subcommands.
- **Staleness signal**: FEATURES.md / SYSTEM-MAP.md were last refreshed 2026-06-14 (this pass). The CLI still exposes ~10 proactive/accountability surfaces (daemon command, watch-folder, webhook, agent-notices, feeds, routine, history/open, propose, approvals, action-log `--verify`) that are not yet prosed into the feature docs — see INDEX §4 D9. Standing objectives were promoted ⚙️→✅ in FEATURES :167 (actuators + objectives-tick + `muse objectives` CLI all present + tested; tick shows `enabled` in `daemon --status`).

## Test evidence summary
- ~52 domain test files across `apps/cli/src`, `packages/mcp/src`, `packages/agent-core/src`, `apps/api/src`.
- Safety-critical paths have dedicated tests: `consented-action.test.ts`, `objective-evaluator.test.ts`, `personal-action-log-store.test.ts` (hash-chain), `undo-action.test.ts`, `personal-veto-store.test.ts`, `proactive-trust-ledger.test.ts`, `personal-proposed-action-store` (via commands-propose).
- (Tests not executed here — read-only catalog pass; existence + naming verified.)
