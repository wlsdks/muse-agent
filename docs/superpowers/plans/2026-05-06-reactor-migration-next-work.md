# Reactor Migration Next Work Queue

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this queue task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Reactor-to-Muse behavior gaps so the migration can be called 100% complete from a Reactor feature-parity perspective.

**Architecture:** Muse remains TypeScript/Node-first with provider-neutral `agent-core`; Reactor is the behavior baseline, not the module template. Every task below must preserve guard fail-close, hook fail-open, approval-before-execution, deterministic trimming, message/tool pair integrity, and queryable persisted state.

**Tech Stack:** Node.js 24 LTS, pnpm workspace, Fastify, Kysely, PostgreSQL, Vitest, Playwright, Rust runner, Cargo, OpenTelemetry/pino.

---

## Current Verified Baseline

These are the current working facts as of 2026-05-06 after the diagnostic provider work:

```bash
source ~/.nvm/nvm.sh
nvm use 24
node -v
```

Expected:

```text
v24.15.0
```

```bash
REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-routes
REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-db
pnpm check
pnpm test:e2e
```

Expected:

```text
verify:reactor-routes: Reactor routes 255, Muse routes 371, Missing Reactor routes 0
verify:reactor-db: Reactor tables 52, Muse tables 64, Missing Reactor tables 0
pnpm check: pass
pnpm test:e2e: 1 Chromium smoke passes
```

Diagnostic live smoke is available without external model credentials:

```bash
source ~/.nvm/nvm.sh
nvm use 24
PORT=3019 MUSE_MODEL=diagnostic/smoke MUSE_MODEL_PROVIDER_ID=diagnostic pnpm --filter @muse/api dev
```

In another shell:

```bash
source ~/.nvm/nvm.sh
nvm use 24
curl -sS -X POST http://127.0.0.1:3019/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"node24 api","runId":"node24-api"}'
curl -sS -N -X POST http://127.0.0.1:3019/api/chat/stream \
  -H 'content-type: application/json' \
  -d '{"message":"node24 stream","runId":"node24-stream"}'
MUSE_MODEL=diagnostic/smoke MUSE_MODEL_PROVIDER_ID=diagnostic pnpm --filter @muse/cli dev chat --local node24-local --json --no-log
pnpm --filter @muse/cli dev chat node24-remote --json --no-log --api-url http://127.0.0.1:3019
```

Expected:

```text
/api/chat returns success true with Diagnostic response
/api/chat/stream returns event: message and event: done
CLI local returns Diagnostic response
CLI remote returns Diagnostic response
```

## Migration Gap Ledger

This is the source-of-truth view for what is still not 100% migrated. Route parity and table-name parity are already green; the remaining work is behavior parity, runtime proof, and store-backed durability.

| Reactor module | Current migration status | Not yet 100% because | Work item |
| --- | --- | --- | --- |
| `runtime-settings` | Complete | No major gap currently identified. | Keep covered by `pnpm check`. |
| `resilience` | Complete | No major gap currently identified. | Keep covered by `pnpm check`. |
| `autoconfigure` | Runtime verification needed | Node 24 diagnostic runtime now works, but production assembly with DB, auth, scheduler, MCP, tracing, and agent runtime together is not yet proven. | Tasks 1, 3, 4, 12 |
| `core` | Runtime verification needed | Fastify replaced Spring Boot intentionally; full server/API/DB runtime smoke still needs durable evidence. | Tasks 3, 4, 6 |
| `persistence-schema` | Runtime verification needed | Table names match, but consolidated Kysely migration has not been proven against real PostgreSQL upgrade/runtime paths. | Task 4 |
| `tool` | Partial | Rust runner bridge exists, but real Rust binary execution and safety constraints are not verified end-to-end. | Task 2 |
| `api` | Partial | Route parity is green, but shared Reactor SPI/DTO behavior is distributed across compatibility routes and needs live smoke plus durable state checks. | Tasks 3, 5, 6 |
| `web` | Partial | Current Playwright smoke is mocked; web has not yet been proven against a live diagnostic API. | Task 6 |
| `agent` | Partial | Core loop exists, but deeper multi-agent/workspace planner, cost/SLO/drift scheduler behavior, and runtime semantic parity need targeted checks. | Tasks 3, 10, 13 |
| `eval` | Partial | Eval storage exists, but Reactor-grade replay lifecycle, run-log enrichment, metadata-only failure, and successful-tool-only grading need explicit parity tests. | Task 13 |
| `memory` | Partial | Deterministic trimming and stores exist, but LLM summary service, session embedding behavior, JDBC/JOOQ-equivalent persistence, and runtime memory smoke remain gaps. | Tasks 4, 10, 13 |
| `rag` | Partial | Retrieval pieces exist, but live vector/persisted ingestion and runtime context injection are not proven end-to-end. | Task 10 |
| `mcp` | Partial | MCP manager/routes exist, but live transport, tool call, reconnect, and policy edge cases need fixture-backed smoke. | Task 9 |
| `slack` | Partial | HTTP route tests exist, but Socket Mode/Web API behavior and synthetic signed event lifecycle need runtime harness coverage. | Task 11 |
| `model-routing` | Partial | Provider abstraction and adapters exist, but adapter contracts/live behavior across providers are narrow. | Task 8 |
| `observability` | Partial | Trace sinks and metrics exist, but production exporter wiring, doctor detail, and queryable trace evidence need deeper tests. | Task 12 |
| `admin` | Partial | Admin routes/stores exist, but rich dashboard analytics, doctor detail, quota hooks, alert evaluation, Timescale/OTLP behavior remain shallow. | Tasks 5, 12, 13 |
| `approval` | Partial | Approval gate exists, but richer Reactor context resolvers and approval UX formatting remain partial. | Task 13 |
| `auth` | Partial | Password/JWT paths exist, but IAM exchange/admin initializer/WebFilter-equivalent identity semantics are narrower. | Task 13 |
| `cache` | Partial | In-memory cache exists; Redis/semantic cache equivalent and semantic retrieval behavior are not migrated. | Task 13 |
| `common` | Partial | Shared primitives exist; boundary violation formatting, cancellation helpers, exact hash/HMAC helpers, and persona extension semantics remain incomplete. | Task 13 |
| `guard` | Partial | Fail-close guard path exists; live classifier calibration and provider contract behavior remain partial. | Tasks 8, 13 |
| `hook` | Partial | Lifecycle hooks exist; standalone Reactor-like HookExecutor/SafeRun API and concrete extension classes are not equivalent. | Task 13 |
| `hook-integrations` | Partial | Several hooks migrated; remaining behavior must stay split correctly between fail-open hooks and fail-close policy/guards. | Task 13 |
| `intent` | Partial | Agent specs/promptlab intents exist; Reactor `IntentResolver`, profile merge/apply, and classifier context are not equivalent. | Task 13 |
| `promptlab` | Partial | Storage/routes exist; live experiment scheduler, winner/confidence metrics, and orchestration parity remain unproven. | Task 13 |
| `prompts` | Partial | Prompt builders/layers exist; broader prompt layer persistence, exemplar management, and persona extension behavior remain incomplete. | Task 13 |
| `scheduler` | Partial | Scheduler runtime exists; richer notification/Teams formatting, dry-run detail, and policy pipeline breadth are partial. | Task 13 |

## Priority Order

1. Preserve the diagnostic runtime milestone so API/CLI chat no longer regresses.
2. Prove the `tool` module by installing/enabling Cargo and verifying the real Rust runner.
3. Prove `autoconfigure`, `core`, and `api` with automated live diagnostic API/SSE/CLI smoke.
4. Prove `persistence-schema` and DB-backed packages with real PostgreSQL/Testcontainers runtime smoke.
5. Audit and remove high-risk process-local state in `reactor-compat-routes.ts`.
6. Prove `web` against a live API, not only mocked browser routes.
7. Close CLI product parity by expanding Ink from status panels to multi-turn chat.
8. Prove `model-routing` and `guard` provider behavior with adapter contract/live tests.
9. Prove `mcp` live tool registration/call/policy behavior.
10. Prove `rag`, `memory`, and `agent` runtime context behavior end-to-end.
11. Prove `slack` event lifecycle and duplicate handling with synthetic fixtures.
12. Deepen `observability` and `admin` diagnostics to Reactor-grade queryability.
13. Sweep the remaining partial modules: `approval`, `auth`, `cache`, `common`, `eval`, `hook`, `hook-integrations`, `intent`, `promptlab`, `prompts`, and `scheduler`.
14. Update the audit documents only after behavior evidence exists.

---

## Task 1: Preserve Diagnostic Runtime Milestone

**Purpose:** Keep the newly working API/CLI diagnostic runtime checkpoint recoverable before starting riskier environment work.

**Files:**
- Verify: `packages/model/src/index.ts`
- Verify: `packages/model/test/model.test.ts`
- Verify: `packages/autoconfigure/src/index.ts`
- Verify: `packages/autoconfigure/test/autoconfigure.test.ts`

- [x] **Step 1: Review the current diff**

Run:

```bash
git diff -- packages/model/src/index.ts packages/model/test/model.test.ts packages/autoconfigure/src/index.ts packages/autoconfigure/test/autoconfigure.test.ts
```

Expected: only diagnostic provider code, autoconfigure wiring, and tests are present.

- [x] **Step 2: Re-run narrow verification under Node 24**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm --filter @muse/model test
pnpm --filter @muse/autoconfigure test
pnpm --filter @muse/model build
pnpm --filter @muse/autoconfigure build
```

Expected: all commands pass.

- [x] **Step 3: Re-run live diagnostic smoke**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
PORT=3019 MUSE_MODEL=diagnostic/smoke MUSE_MODEL_PROVIDER_ID=diagnostic pnpm --filter @muse/api dev
```

In another shell:

```bash
source ~/.nvm/nvm.sh
nvm use 24
curl -sS -X POST http://127.0.0.1:3019/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"diagnostic commit check","runId":"diagnostic-commit-check"}'
pnpm --filter @muse/cli dev chat diagnostic-remote --json --no-log --api-url http://127.0.0.1:3019
MUSE_MODEL=diagnostic/smoke MUSE_MODEL_PROVIDER_ID=diagnostic pnpm --filter @muse/cli dev chat --local diagnostic-local --json --no-log
```

Expected: all three return `Diagnostic response`.

- [x] **Step 4: Commit the milestone**

Run:

```bash
git add packages/model/src/index.ts packages/model/test/model.test.ts packages/autoconfigure/src/index.ts packages/autoconfigure/test/autoconfigure.test.ts
git commit -m "feat: add diagnostic model runtime smoke"
```

Expected: commit succeeds. If the user does not want commits yet, record the reason in the final summary and keep the diff uncommitted.

## Task 2: Rust Runner Verification

**Purpose:** Move the runner from TypeScript bridge-tested to Rust binary-tested.

**Files:**
- Verify: `crates/runner/Cargo.toml`
- Verify: `crates/runner/src/main.rs`
- Verify: `packages/tools/src/index.ts`
- Verify: `packages/tools/test/tools.test.ts`

- [x] **Step 1: Check Rust toolchain availability**

Run:

```bash
command -v cargo
cargo --version
```

Expected: `cargo` path and version print. If missing, install Rust with:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo --version
```

- [x] **Step 2: Run Rust tests**

Run:

```bash
cargo test -p muse-runner
```

Expected: runner crate tests pass. If there are no tests, add tests before changing runner behavior.

- [x] **Step 3: Build the runner binary**

Run:

```bash
cargo build -p muse-runner
```

Expected: binary builds under `target/debug/muse-runner`.

- [x] **Step 4: Verify TypeScript bridge against the real binary**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
MUSE_RUNNER_ENABLED=true MUSE_RUNNER_PATH="$PWD/target/debug/muse-runner" pnpm --filter @muse/tools test
```

Expected: tools tests pass. If existing tests only inject a fake runner, add a new test that invokes the real binary.

## Task 3: Automated Live Diagnostic Smoke

**Purpose:** Turn the manual diagnostic API/CLI smoke into repeatable verification.

**Files:**
- Create: `scripts/smoke-diagnostic-runtime.mjs`
- Modify: `package.json`
- Test: use the script itself as an integration smoke

- [x] **Step 1: Create the smoke script**

Create `scripts/smoke-diagnostic-runtime.mjs` with a Node 24 script that:

```text
1. Starts `pnpm --filter @muse/api dev` on a free local port.
2. Sets `MUSE_MODEL=diagnostic/smoke` and `MUSE_MODEL_PROVIDER_ID=diagnostic`.
3. Waits for `/health`.
4. POSTs `/api/chat`.
5. POSTs `/api/chat/stream`.
6. Runs CLI local chat.
7. Runs CLI remote chat against the started API.
8. Kills the API process.
9. Exits 1 if any assertion fails.
```

- [x] **Step 2: Add assertions**

The script must assert:

```text
/health status is ok
/api/chat status is 200
/api/chat JSON has success true
/api/chat content includes Diagnostic response
/api/chat/stream includes event: message
/api/chat/stream includes event: done
CLI local JSON response includes Diagnostic response
CLI remote JSON content includes Diagnostic response
```

- [x] **Step 3: Wire npm script**

Modify root `package.json`:

```json
"smoke:diagnostic": "node scripts/smoke-diagnostic-runtime.mjs"
```

- [x] **Step 4: Verify**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm smoke:diagnostic
pnpm check
```

Expected: both commands pass.

## Task 4: PostgreSQL Runtime Smoke

**Purpose:** Prove consolidated Kysely migrations and DB-backed stores work against real PostgreSQL, not only type-level or DummyDriver tests.

**Files:**
- Create: `packages/db/test/postgres-runtime.test.ts`
- Modify: `packages/db/package.json`
- Possibly modify: `packages/db/src/migrations.ts`
- Possibly modify: `packages/runtime-state/test/*.test.ts`

- [ ] **Step 1: Decide test backend**

Use Testcontainers if Docker is available:

```bash
docker info
```

Expected: Docker responds. If Docker is not available, use a local PostgreSQL URL through `MUSE_TEST_DATABASE_URL`.

- [ ] **Step 2: Add migration smoke**

Add a test that:

```text
1. Opens a PostgreSQL Kysely connection.
2. Applies Muse migrations from `packages/db/src/migrations.ts`.
3. Verifies representative tables exist: `agent_runs`, `agent_messages`, `pending_approvals`, `trace_events`, `runtime_settings`, `users`.
4. Inserts and reads one row through package-level Kysely stores rather than raw SQL where possible.
```

- [ ] **Step 3: Add package script**

Modify `packages/db/package.json`:

```json
"test:postgres": "vitest run test/postgres-runtime.test.ts"
```

- [ ] **Step 4: Verify**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm --filter @muse/db test:postgres
pnpm --filter @muse/db test
```

Expected: both pass. If Docker/Postgres is unavailable, final summary must say `PostgreSQL runtime smoke not yet verified`.

## Task 5: Remove High-Risk Process-Local Compat State

**Purpose:** Find compatibility routes that still keep important state in local `Map`s and move the highest-risk ones into stores.

**Files:**
- Inspect: `apps/api/src/reactor-compat-routes.ts`
- Modify as needed: `packages/runtime-state/src/*.ts`
- Modify as needed: `packages/promptlab/src/index.ts`
- Modify as needed: `packages/policy/src/index.ts`
- Modify as needed: `apps/api/test/server.test.ts`

- [ ] **Step 1: Inventory remaining local Maps**

Run:

```bash
rg -n "new Map|const .*Map|= new Map" apps/api/src/reactor-compat-routes.ts
```

Expected: list every local map-like state holder.

- [ ] **Step 2: Classify by risk**

Create a short table in `docs/audits/reactor-module-parity-audit-2026-05-06.md`:

```text
route family | current state holder | user impact if process restarts | target store | status
```

- [ ] **Step 3: Move one high-risk family**

Pick the highest-risk family that affects approvals, audits, run history, guard policy, promptlab, or runtime settings. Add a failing API test that:

```text
1. Writes state through the route.
2. Creates a fresh server instance using the same backing store.
3. Reads the state through the route.
4. Expects the state to survive.
```

- [ ] **Step 4: Implement the store wiring**

Move route reads/writes from local process state into the existing package store or add a narrow store method in the package that owns the data.

- [ ] **Step 5: Verify**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm --filter @muse/api test
pnpm check
```

Expected: all pass.

## Task 6: Live Web-to-API Smoke

**Purpose:** Replace mocked-only web confidence with a browser flow against a real diagnostic API.

**Files:**
- Create: `apps/web/e2e/live-api.spec.ts`
- Modify: `apps/web/playwright.config.ts` or add a separate Playwright config
- Modify: `package.json`

- [ ] **Step 1: Add a live API Playwright test**

The test must:

```text
1. Start or target an API server with diagnostic provider.
2. Open the web app.
3. Fill the chat input.
4. Click Run.
5. Assert the rendered output contains Diagnostic response.
6. Assert runtime status is ok.
```

- [ ] **Step 2: Wire script**

Modify root `package.json`:

```json
"test:e2e:live": "pnpm --filter @muse/web test:e2e -- live-api.spec.ts"
```

- [ ] **Step 3: Verify**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm test:e2e
pnpm test:e2e:live
```

Expected: mocked smoke and live diagnostic smoke both pass.

## Task 7: Ink Multi-Turn Chat TUI

**Purpose:** Close the remaining CLI product gap: current Ink TUI is status-panel oriented, not a multi-turn chat surface.

**Files:**
- Modify: `apps/cli/src/tui.ts`
- Modify: `apps/cli/src/program.ts`
- Modify: `apps/cli/test/program.test.ts`

- [ ] **Step 1: Add a failing CLI/TUI test**

Test expected behavior:

```text
`muse tui --local` can render chat mode with a prompt model, submit a user message, append assistant output, and keep the previous turn visible.
```

- [ ] **Step 2: Implement local-mode chat state in Ink**

Use existing `AgentRuntime` assembly and diagnostic provider for testability. The TUI must not fork agent behavior; it must call the same runtime path as `muse chat --local`.

- [ ] **Step 3: Implement remote-mode chat state in Ink**

Use existing remote API request/stream helpers. Remote chat should share config and credentials resolution with non-TUI CLI chat.

- [ ] **Step 4: Verify**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm --filter @muse/cli test
pnpm --filter @muse/cli build
pnpm check
```

Expected: all pass.

## Task 8: Provider Adapter Contract Coverage

**Purpose:** Prove provider adapters keep Muse-owned contracts while supporting public adapter differences.

**Files:**
- Modify: `packages/model/test/model.test.ts`
- Possibly create: `packages/model/test/provider-contract.test.ts`

- [ ] **Step 1: Add contract cases for each adapter**

For OpenAI-compatible, OpenAI, OpenRouter, Ollama, Anthropic, and Gemini, assert:

```text
listModels returns provider/model IDs and capabilities
generate maps provider response into ModelResponse
stream maps provider text deltas and final done event where streaming is supported
errors become ModelProviderError with provider ID
tool calls map into provider-neutral ModelToolCall where supported
```

- [ ] **Step 2: Add optional live smoke gates**

Live tests must be skipped unless credentials are present:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY or GOOGLE_API_KEY
OPENROUTER_API_KEY
OLLAMA_BASE_URL or local Ollama server
```

- [ ] **Step 3: Verify**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm --filter @muse/model test
pnpm check
```

Expected: contract tests pass without live credentials; live tests skip clearly when credentials are absent.

## Task 9: MCP Live Governance Smoke

**Purpose:** Prove MCP server registration, preflight, tool exposure, policy gating, and reconnect behavior with a real transport.

**Files:**
- Modify: `packages/mcp/test/mcp.test.ts`
- Modify: `apps/api/test/server.test.ts`
- Possibly create: `scripts/smoke-mcp-local.mjs`

- [ ] **Step 1: Add a local MCP fixture server**

Use a minimal stdio MCP fixture that exposes one read-only tool returning synthetic data.

- [ ] **Step 2: Add API smoke**

Assert:

```text
POST /api/mcp/servers registers local fixture
GET /api/mcp/servers/:name/health returns connected or healthy
GET /api/mcp/servers/:name/tools lists the fixture tool
POST /api/mcp/servers/:name/tools/:toolName/call returns sanitized output
policy denies disallowed server names and private remote addresses by default
```

- [ ] **Step 3: Verify**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm --filter @muse/mcp test
pnpm --filter @muse/api test
pnpm check
```

Expected: all pass.

## Task 10: RAG End-to-End Runtime Smoke

**Purpose:** Prove ingestion, retrieval, compression, and agent prompt injection work together with synthetic documents.

**Files:**
- Modify: `packages/rag/test/rag.test.ts`
- Modify: `packages/agent-core/test/agent-runtime.test.ts`
- Possibly modify: `apps/api/test/server.test.ts`

- [ ] **Step 1: Add synthetic document fixture**

Use neutral content only:

```text
Document A: "The release can use phased rollout with rollback gates."
Document B: "The release can use big-bang migration with longer freeze."
```

- [ ] **Step 2: Add retrieval assertion**

Assert query `"Which release path has rollback gates?"` retrieves Document A above Document B.

- [ ] **Step 3: Add runtime assertion**

Run agent-core with diagnostic provider and RAG context. Assert the model request receives the relevant context block before generation.

- [ ] **Step 4: Verify**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm --filter @muse/rag test
pnpm --filter @muse/agent-core test
pnpm check
```

Expected: all pass.

## Task 11: Slack Runtime Verification Harness

**Purpose:** Move Slack from route/unit confidence to live-ish event handling confidence without real workspace data.

**Files:**
- Modify: `packages/integrations/test/integrations.test.ts`
- Modify: `apps/api/test/server.test.ts`
- Possibly create: `scripts/smoke-slack-fixture.mjs`

- [ ] **Step 1: Add signed event fixture**

Use synthetic IDs only:

```text
team_id: T123EXAMPLE
channel: C123EXAMPLE
user: U123EXAMPLE
text: "muse compare rollout options"
```

- [ ] **Step 2: Assert Events API behavior**

Assert:

```text
valid Slack signature is accepted
invalid signature is rejected
retry duplicate is deduplicated
app mention routes to the agent gateway when configured
response tracking and feedback metadata persist
```

- [ ] **Step 3: Verify**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm --filter @muse/integrations test
pnpm --filter @muse/api test
pnpm check
```

Expected: all pass.

## Task 12: Observability And Diagnostics Deepening

**Purpose:** Close the current observability gap around production exporter wiring, richer doctor details, and persisted trace verification.

**Files:**
- Modify: `packages/observability/src/index.ts`
- Modify: `packages/observability/test/observability.test.ts`
- Modify: `apps/api/src/admin-routes.ts`
- Modify: `apps/api/test/server.test.ts`

- [ ] **Step 1: Add a failing persisted trace test**

Assert a diagnostic chat run records:

```text
run started
model generate started
model generate completed
run completed
```

and that records are queryable by `runId`.

- [ ] **Step 2: Add doctor detail assertions**

Assert admin doctor output includes:

```text
model provider configured
database configured or in-memory
runner configured or disabled
MCP configured or empty
trace sink configured
```

- [ ] **Step 3: Verify**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm --filter @muse/observability test
pnpm --filter @muse/api test
pnpm check
```

Expected: all pass.

## Task 13: Remaining Module Parity Sweeps

**Purpose:** Close the partial Reactor modules that are not covered by the larger runner, DB, web, provider, MCP, RAG, Slack, and observability tasks.

**Files:**
- Inspect: `/Users/stark/ai/reactor/modules/{admin,approval,auth,cache,common,eval,guard,hook,hook-integrations,intent,promptlab,prompts,scheduler}`
- Inspect: `docs/audits/reactor-module-parity-audit-2026-05-06.md`
- Modify as needed: `apps/api/src/reactor-compat-routes.ts`
- Modify as needed: `apps/api/test/server.test.ts`
- Modify as needed: `packages/*/src/index.ts`
- Modify as needed: `packages/*/test/*.test.ts`

- [ ] **Step 1: Create a module gap checklist from Reactor source**

For each module in this exact list, inspect Reactor source and Muse target code:

```text
admin
approval
auth
cache
common
eval
guard
hook
hook-integrations
intent
promptlab
prompts
scheduler
```

Write findings into `docs/audits/reactor-module-parity-audit-2026-05-06.md` using this format:

```text
Reactor module | Reactor behavior | Muse equivalent | Missing behavior | Test proving closure
```

- [ ] **Step 2: Close `eval` semantic parity first**

Reactor's important eval semantics are:

```text
metadata-only eval cases must fail
expected tool names count only successful tool calls
failed tool calls do not satisfy expected tool usage
debug replay keeps source run and deterministic replay run distinct
run-log enrichment survives persistence
```

Add or verify tests under `packages/eval/test/eval.test.ts` and `apps/api/test/server.test.ts`.

- [ ] **Step 3: Close `guard` and `approval` policy parity**

Required behavior:

```text
guards fail close
hooks fail open
security decisions live in guards/policy, not prompt text
risky tools require approval before execution
tool output is sanitized before model reuse or UI display
approval context is redacted and specific enough for user review
```

Add or verify tests under `packages/policy/test/*.test.ts`, `packages/agent-core/test/agent-runtime.test.ts`, and `apps/api/test/server.test.ts`.

- [ ] **Step 4: Close `auth` parity gaps**

Required behavior:

```text
admin initializer or equivalent bootstrap path is explicit
identity resolution is tested for bearer token, missing token, revoked token, and admin role
compatibility aliases do not bypass auth requirements
rate limits behave deterministically
```

Add or verify tests under `packages/auth/test/auth.test.ts` and `apps/api/test/server.test.ts`.

- [ ] **Step 5: Close `promptlab`, `prompts`, and `intent` parity gaps**

Required behavior:

```text
intent definitions can be resolved and applied to agent specs
persona/template/provider prompt layers resolve in deterministic order
prompt exemplars can be retrieved and injected without breaking guard/hook semantics
experiment reports include winner/confidence metrics or explicitly documented equivalent semantics
```

Add or verify tests under `packages/promptlab/test/promptlab.test.ts`, `packages/prompts/test/prompts.test.ts`, `packages/agent-specs/test/agent-specs.test.ts`, and `apps/api/test/server.test.ts`.

- [ ] **Step 6: Close `scheduler` parity gaps**

Required behavior:

```text
dry-run exposes enough detail to debug execution
agent jobs and MCP jobs preserve retry and timeout behavior
distributed lock behavior is covered
notification formatting is either migrated or explicitly documented as intentionally out of scope
```

Add or verify tests under `packages/scheduler/test/scheduler.test.ts` and `apps/api/test/server.test.ts`.

- [ ] **Step 7: Close `cache` and `common` parity gaps**

Required behavior:

```text
cache key construction is deterministic
cache invalidation and stats are queryable
semantic cache gap is either implemented or explicitly marked as intentionally not migrated
boundary violation formatting exists where Reactor exposed it
cancellation helpers or equivalent stop conditions are deterministic
hash/HMAC helpers needed by migrated behavior are present
```

Add or verify tests under `packages/cache/test/cache.test.ts`, `packages/shared/test/shared.test.ts`, and any package that owns the equivalent helper.

- [ ] **Step 8: Close `hook` and `hook-integrations` parity gaps**

Required behavior:

```text
start/complete/failure hooks do not fail the run when hook work throws
hook traces persist enough detail for debugging
write-tool blocking remains in guard/policy, not fail-open hooks
webhook, feedback, RAG ingestion, and user memory hooks use synthetic fixtures only
```

Add or verify tests under `packages/agent-core/test/agent-runtime.test.ts`, `packages/integrations/test/integrations.test.ts`, and `packages/runtime-state/test/*.test.ts`.

- [ ] **Step 9: Verify the sweep**

Run:

```bash
source ~/.nvm/nvm.sh
nvm use 24
pnpm check
REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-routes
REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-db
```

Expected: all pass. Do not mark any module complete until its missing behavior has a passing test or an explicit product decision says it should not be migrated.

## Task 14: Update Final Audit Documents

**Purpose:** Keep the human-readable migration status accurate after each completed milestone.

**Files:**
- Modify: `docs/audits/reactor-module-parity-audit-2026-05-06.md`
- Modify: `docs/superpowers/plans/2026-05-06-reactor-migration-completion.md`
- Modify: `docs/superpowers/plans/2026-05-06-reactor-migration-next-work.md`

- [ ] **Step 1: Update verification snapshot**

Record exact commands and results for:

```bash
node -v
REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-routes
REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-db
pnpm check
pnpm test:e2e
pnpm smoke:diagnostic
cargo test -p muse-runner
```

- [ ] **Step 2: Update module statuses**

Only move a module out of `Partial` or `Needs runtime verification` when there is behavior-level evidence, not just route or table parity.

- [ ] **Step 3: Verify docs**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

## Completion Bar

Do not call the migration complete until all of these are true:

```bash
source ~/.nvm/nvm.sh
nvm use 24
REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-routes
REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-db
pnpm check
pnpm test:e2e
pnpm smoke:diagnostic
cargo test -p muse-runner
```

And these behavior checks have evidence:

```text
API chat works with a configured provider.
API SSE chat works with a configured provider.
CLI local chat works through shared agent-core.
CLI remote chat works through API.
Web chat works against a live API, not only mocked routes.
PostgreSQL migrations apply and representative stores read/write.
Runner executes through Rust binary and respects command safety constraints.
At least one provider adapter has a live smoke or all adapters have robust contract tests.
MCP local fixture registers, exposes, calls, and enforces policy.
Slack signed events and duplicate handling are covered with synthetic fixtures.
RAG retrieval and runtime context injection are covered with synthetic documents.
Trace events for a run are persisted and queryable.
```
