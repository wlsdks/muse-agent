# Domain Catalog 06 — Outbound actions & safety + Multi-agent/Swarm + Voice

Repo: /Users/jinan/side-project/Muse · Date: 2026-06-14 · Branch: main

Legend: ✅ ran (read-only live) · 🧪 tests as evidence · ⬜ code-only · ⚠️ broken/suspicious

---

## HEADLINE

The outbound-safety contract is **fully implemented AND contract-faithfully tested** — deny/timeout/ambiguous-recipient/absent-consent all proven to produce no external effect by deterministic (no-Ollama) eval batteries that PASS live. Voice is local-by-construction (OpenAI key forced `undefined` under `MUSE_LOCAL_ONLY`, default ON). A2A swarm is opt-in, HMAC-signed, PII-redacted, inbound-quarantined. Multi-agent orchestration runs sequential/parallel/tiered.

**One stale test found AND FIXED (2026-06-14):** the `smoke:broad` "race mode" failure was a **STALE TEST**, not a product regression. `race` mode was deliberately PARKED (2026-06) and resolves to `sequential`, which returns one result PER worker (2 with 2 workers). The smoke assertion had expected exactly 1; it has since been updated to expect 2 (`smoke:broad` now 51 pass / 0 fail). The matching `docs/FEATURES.md`/`SYSTEM-MAP.md` race wording was also corrected to "parked → sequential".

---

## RACE-MODE BUG — VERDICT

**Verdict: STALE TEST (false positive in smoke:broad), NOT a product bug. Race mode behaves correctly per its current "PARKED" design.**

### Evidence chain
- `packages/multi-agent/src/index.ts:57-63` — `OrchestrationMode` doc comment: *"`race` is PARKED (2026-06 maturity review): on a single local GPU 'first useful answer wins' is fiction — Ollama serializes the workers anyway… The wire value stays accepted for compat and resolves to `sequential`."*
- `packages/multi-agent/src/index.ts:370-372` — in `MultiAgentOrchestrator.run`: `else if (mode === "race") { /* parked: resolves to sequential */ results = await this.runSequential(...) }`. `runSequential` runs **every** worker and pushes one `OrchestrationStepResult` per worker (line ~456-478).
- `apps/api/src/multi-agent-routes.ts:208-223` — `POST /api/multi-agent/orchestrate` returns `results: orchestration.results.map(...)` — ALL step results, with no "pick one winner" reduction for race.
- `packages/multi-agent/test/multi-agent.test.ts:290-313` — unit test "race mode is PARKED… runs sequentially" explicitly asserts `expect(result.results).toHaveLength(2)` for 2 workers, and both run in registration order. This is the AUTHORITATIVE current contract.
- `scripts/smoke-broad-http.mjs:615-632` — the smoke test posts `mode:"race"` with 2 workers. It HAD asserted `body.results.length === 1` (which failed "got 2"); **fixed 2026-06-14** to assert `results.length === 2` and all completed, matching the parked→sequential behavior.

### Pinpoint
- Authoritative behavior: `packages/multi-agent/src/index.ts:370-372` (race→sequential) + `runSequential` returns N results (one per worker).
- Fix APPLIED 2026-06-14: the smoke assertion now expects `results.length === 2` and all completed (mirrors the parallel block at 595-613). The orchestrator was intentionally left unchanged — its parked behavior is correct.

---

## OUTBOUND ACTIONS & SAFETY

### Approval gates / draft-first
- **`createChannelApprovalGate` (channel approval gate)** — `packages/messaging/src/channel-approval-gate.ts:90`. ⬜ code + 🧪. Fail-CLOSED: `read` risk passes; any state-changing tool from chat is DENIED, a refusal recorded (recording failure can't flip the decision — `catch{}`), an in-chat notice attempted (notice send failure still denies), returns `{allowed:false}`. Matches outbound-safety rule 2 exactly.
- **`toolApprovalGate` / `ToolApprovalGate`** — `packages/agent-core/src/agent-runtime.ts:218`, type at `agent-runtime-types.ts:217`. ⬜ code. The agent-core seam the channel gate plugs into.
- **`muse email send/reply/forward`** — `apps/cli/src/commands-email.ts`. ✅ `--help` confirms: "Draft an email… and send it only after you confirm the exact content"; reply/forward are draft-first too. 🧪 `commands-email.test.ts` (passes in full CLI run, 2700/2700).
- **`muse web-action`** — `apps/cli/src/commands-web-action.ts`. ✅ `--help`: "Perform a confirmation-gated web action (submit/book). Never autonomous; not for payments." Source line 8 comment: "NOT for banking / payments — out of scope per outbound-safety." `confirm()` gate at line 49; no confirm ⇒ `{approved:false}`. 🧪 `commands-web-action.test.ts`.
- **`muse home call/state/entities`** — `apps/cli/src/commands-home.ts`. ✅ `--help`: Home Assistant control, "only after you confirm"; `state`/`entities` read-only. ⚙️ (needs real HA env to live-verify control). 🧪 `commands-home.test.ts`.
- **`muse messaging send / providers / inbox`** — `apps/cli/src/commands-messaging.ts`, `commands-messaging-send.ts`. ✅ ran `messaging providers --local` → "1 provider: log [local]". `send` is gated. 🧪 `commands-messaging.test.ts`, `commands-messaging-send.test.ts`.

### Pending-approval worklists (two distinct surfaces — NOT duplicates)
- **`muse approval list/approve/deny/request`** — tool-call approvals (audit + trust list). ✅ `--help`.
- **`muse approvals list/approve/clear`** — channel actions awaiting approval (live pending worklist; `approve` re-runs the gated tool after exact-draft confirm). ✅ `--help`. 🧪 `commands-approval.test.ts`, `commands-approvals.test.ts`.
- Note: two near-identical command names (`approval` vs `approvals`) — minor confusability risk, but they govern different stores (tool-trust vs channel-action queue).

### Recipient resolution (never guessed)
- **`resolveContact` (@muse/mcp)** driven by **`eval:recipient-resolution`** (`scripts/eval-recipient-resolution.mjs`). ✅ RAN — PASS. Asserts: unique name ⇒ resolves to real recorded address (never invented); two "Alex" ⇒ `ambiguous` with ALL candidates surfaced (never silently picks); unknown/empty ⇒ `unknown` (never invents); resolves by email/@handle; relationship word ("manager") does NOT resolve. Contract-faithful, deterministic.

### Scoped consent for standing objectives
- **`performConsentedAction` (@muse/mcp)** driven by **`eval:consent-fail-close`** (`scripts/eval-consent-fail-close.mjs`). ✅ RAN — PASS. Asserts: no recorded consent ⇒ performed:false + NO request (credential never leaves); scope+host-matched consent ⇒ performed:true + exactly one request; different scope ⇒ false (no implicit broadening); host ≠ consented allowedHost ⇒ false (no credential exfil); recorded veto overrides prior consent; hung endpoint ⇒ bounded timeout, performed:false. This is the strongest single proof of outbound-safety rule 5.

### Action-log recording (tamper-evident)
- **`eval:action-log-tamper`** (`scripts/eval-action-log-tamper.mjs`). ✅ RAN — PASS. Action log is a hash chain: a one-field edit / silent deletion / reorder is caught at a precise index; refused actions ARE chained; undo of an irreversible action records a durable VETO and EXTENDS (never breaks) the chain. Satisfies outbound-safety rule 4 (recorded + reversible-where-possible).

### Banking out of scope
- ✅ Confirmed: `apps/cli/src/commands-web-action.ts:8` ("NOT for banking / payments — out of scope per outbound-safety") and the `--help` description "not for payments". No banking/brokerage/money-movement command exists anywhere in the domain. Matches outbound-safety "Out of scope — never built."

### Policy package (input/output guards, red-team)
- `packages/policy/src/` — 12 source modules + 13 test modules. Key: `adversarial-red-team.ts`, `injection-patterns.ts` (+ multilingual), `injection-detection-counter.ts`, `pii-patterns.ts`, `prompt-leakage.ts`, `source-block-sanitizer.ts`, `tool-output-sanitizer.ts`, `topic-drift.ts`, `migration-redaction.ts`, `structured-output.ts`, `guard-monitor.ts`.
- **`eval:policy-symmetry`** (`scripts/eval-policy-symmetry.mjs`). ✅ RAN — PASS. Deterministic, language-symmetric guards: HTML-entity-split / zero-width-split injection decoded then caught; `maskPii` returns a NEW masked copy (never in-place); benign EN/KO prose not over-blocked; system-prompt leak detected in EN and KO.
- **`eval:adversarial`** (`scripts/eval-adversarial.mjs`) — must-refuse + over-refusal controls (LLM, local-Ollama; not run here — needs Ollama). 🧪 + ⬜.

---

## MULTI-AGENT / ORCHESTRATION

### Core (`packages/multi-agent`)
- **`MultiAgentOrchestrator.run`** — `index.ts:343`. ⬜ + 🧪. Modes: `sequential` (default; handoff chain via `addHandoffMessage`), `parallel` (`runParallel`, fan-out), `race` (PARKED → sequential, see bug section). Validates each worker output via `parseWorkerResult` + `validateWorkerHandoff` (`worker-result.ts`) — typed hand-off check at the seam (MAST). Throws `NoAgentWorkerError` if no worker completes. Records history.
- **`AgentWorker` / `RuntimeAgentWorker` / `RuleBasedAgentWorker`** — `index.ts:30,155,173`. Per-worker optional `model` override enables tiering.
- **`InMemoryAgentMessageBus`** — `agent-message-bus.ts:54`. publish/subscribe/getConversation/clear; `maxSubscribers` FIFO-evict bound (default 1000).
- **Model tiering** — `tiering.ts` (`classifyTier`, `planTieredRun`). `buildTieredOrchestration` (`multi-agent-routes.ts:454`) assigns fast vs heavy model per worker role; `MUSE_TIER_SINGLE_MODEL_HOST` collapses to single heavy model + forces sequential. 🧪.
- **Run history / stats** — `orchestration-history.ts` (`InMemoryOrchestrationHistoryStore`). 🧪.
- 🧪 `pnpm --filter @muse/multi-agent` — race-parked test asserts both workers run + `results.toHaveLength(2)`; deny/all-fail/bus-reject/no-hang paths all covered.

### Council / proposers (`packages/agent-core/src/orchestrate.ts`)
- **`orchestrateAnswer` / `DEFAULT_ROLES`** (practical / thorough / skeptic). ⬜. `dedupeRolesById` enforces MAST "no duplicated sub-agent work". `failedRoles` surfaced (never swallowed). Synthesis cites only proposers it drew on (`contributors`).

### API surface (`apps/api/src/multi-agent-routes.ts`)
- `GET /api/multi-agent/orchestrations` (strict limit parse), `…/stats`, `…/:runId`, `POST …/orchestrate`, `POST …/orchestrate/stream` (SSE, `toMultiAgentSseStream` with leak-safe unsubscribe in `finally`). ⬜ + 🧪 (`apps/api/test/multi-agent-sse-stream.test.ts`).
- `parseOrchestrateBody` still ACCEPTS `mode:"race"` on the wire (compat, by design) — line 529.

### CLI (`muse orchestrate`)
- ✅ `--help`: `run` (--mode sequential|parallel|race, --workers, --max-workers, --model, --tiered) / `list` / `get <runId>` / `stats`. All proxy the API endpoints. `run --help` still lists `race` as a mode (compat, matches wire).
- `muse agents list/path/show/add` — manual sub-agent scaffolds (~/.muse/agents). ✅ ran `agents list` → "No agents yet."

---

## A2A SWARM / FEDERATION (`packages/a2a`)

- ✅ ran `muse swarm status` → A2A OFF (MUSE_A2A_ENABLED), Council OFF, Grounded-council OFF, 0 quarantined. Opt-in confirmed.
- **Subcommands** ✅ `--help`: `status`, `pending`, `promote <id>`, `share <skill> --to <peer> [--yes]` (draft-first; --yes confirms), `serve` (inbound endpoint, off unless MUSE_A2A_ENABLED), `council <question> [--rounds n]`, `reject <id>`.
- **Opt-in** — `MUSE_A2A_ENABLED` gates serve/share; default OFF.
- **Signed transfer** — `signing.ts` (`signEnvelope`/`verifySignature`, canonicalize). Per-envelope **HMAC-SHA256** in `x-muse-a2a-signature` header keyed by peer shared secret (`agent-card.ts:104`). 🧪 `signing.test.ts`.
- **Secret redaction** — envelopes carry `redacted` flag; agent card: "accepts and sends ONLY PII-redacted know-how" (`agent-card.ts:83`). `packages/policy/migration-redaction.ts` provides the redaction primitives.
- **Quarantine until human-promote** — `receive-quarantine.ts`; agent card: "Receive a PII-redacted {kind} into quarantine (execute-gated). Never executed; the user promotes it" (`agent-card.ts:63`). "Inbound is inert — quarantined or rejected, never executed. A peer cannot trigger compute" (`agent-card.ts:83`). 🧪 `receive-quarantine.test.ts`.
- **Council multi-agent debate + grounding gate** — `council-wire.ts` (`buildCouncilRequest`, `COUNCIL_METHOD`); `commands-swarm.ts:33-34,348-350`: in grounded mode (`MUSE_A2A_COUNCIL_GROUNDED`) the member **self-ABSTAINS** when its own notes can't ground a take (only abstain/speak decision crosses, not data). `--rounds` (ReConcile debate; default 2). Synthesis cites only what peers actually answered.
- 🧪 `pnpm --filter @muse/a2a test` → **120/120 pass** (17 files). Only warning: harmless "sourcemap points to missing source" (test dist artifact, not a failure).
- Only reasoning/know-how crosses; notes/memory/contacts never leave (single-user posture exception).

---

## VOICE (`packages/voice`)

- **`VoiceProviderRegistry`** — `registry.ts:12`. STT+TTS maps; primary = first registered.
- **STT providers**: `WhisperCppSttProvider` (`whisper-cpp.ts`, local, `describe().local:true`, timeout-guarded spawn), `OpenAIWhisperSttProvider` (cloud). 
- **TTS providers**: `PiperTtsProvider` (`piper.ts`, local, WAV only, SIGKILL timeout default 120s), `OpenAITtsProvider` (`openai-tts.ts`, cloud, `describe().local:false`).
- **Wake word** — `wake-word.ts`: `WakeWordDetector` interface + `TextScanWakeWordDetector` (text-scan; audio detector is a future `feedAudioFrame()` API). ⬜ + 🧪.
- **Local-only registers ONLY local engines** — ✅ VERIFIED in code: `packages/autoconfigure/src/registry-builders/voice.ts:77-79` — under `MUSE_LOCAL_ONLY` (default `true`), `openAiKey` is forced to `undefined`, killing every cloud STT/TTS branch; only whisper.cpp/piper register; if neither configured, registry is `undefined` → `/api/voice/*` routes 404 (no silent send). Matches architecture.md "voice registry ignores an OpenAI key under local-only."
- **CLI**:
  - `muse listen` ✅ `--help`: push-to-talk loop (--lang, --voice, --format, **--wake `<phrase>`** ambient mode, --clip-seconds). NOT started (blocks/opens mic).
  - `muse voice providers / tts <text> --out` ✅ `--help` (providers/tts proxy the API). Tried `voice providers` live → "API not reachable" (expected; no server running, no `--local` for this cmd).
  - `muse setup voice` ✅ `--help` — probes local whisper.cpp STT + piper TTS toolchain and reports install gaps (--json). NOTE: the catalog task called this `setup-voice`; the actual command is **`muse setup voice`** (subcommand of `setup`), registered via `registerSetupVoiceCommand`.

---

## DOC DRIFT (record)

1. ✅ FIXED 2026-06-14 — `docs/FEATURES.md` race-mode claim (was at :194, now :208) corrected from "경쟁(가장 먼저 끝난 것 채택)" to "parked → sequential"; `SYSTEM-MAP.md` likewise. README.md was already correct ("Sequential or parallel").
2. ✅ FIXED 2026-06-14 — `scripts/smoke-broad-http.mjs` race assertion updated (1→2 results); smoke:broad now 51 pass / 0 fail.
3. **Minor: command-name drift in task spec** — there is no `muse setup-voice`; it is `muse setup voice`. (Docs/FEATURES use `setup` correctly; flag only because the catalog brief used `setup-voice`.)
4. **SYSTEM-MAP coverage** — SYSTEM-MAP.md covers outbound safety prose (draft-first / fail-closed at lines 162-163) but does NOT name the policy/messaging/multi-agent/a2a/voice packages or orchestration modes explicitly; lighter than README's package map. Not wrong, just thin for this domain.
5. **No drift** on outbound-safety.md itself — every one of its 5 rules + banking-out-of-scope maps to a passing deterministic eval (consent-fail-close, recipient-resolution, action-log-tamper, policy-symmetry) and live `--help`/code. The contract and the implementation are in sync.

---

## VERIFICATION SUMMARY

| Check | Status |
|---|---|
| eval:consent-fail-close | ✅ RAN — PASS |
| eval:recipient-resolution | ✅ RAN — PASS |
| eval:policy-symmetry | ✅ RAN — PASS |
| eval:action-log-tamper | ✅ RAN — PASS |
| @muse/a2a test | ✅ RAN — 120/120 |
| @muse/cli outbound tests (email/messaging/web-action/swarm) | ✅ RAN — 2700/2700 |
| All domain CLI `--help` captured | ✅ |
| swarm status / messaging providers / agents list (read-only) | ✅ RAN |
| Voice local-only enforcement | ✅ code-verified (voice.ts:77-79) |
| Race-mode bug | ✅ stale test fixed (race parked→sequential; smoke 1→2) |
| eval:adversarial / eval:orchestration / smoke:live | ⬜ not run (need local Ollama) |
