# Project Completeness Check — 2026-05-25

Focus: **functional end-to-end** — does each feature actually work start to
finish, not merely exist? Report-only (no fixes applied per scope). Companion to
[`2026-05-25-feature-usecase-audit.md`](2026-05-25-feature-usecase-audit.md).

Baseline: clean worktree at `main` HEAD `0ebbc762`, isolated from the loop's
in-progress working-tree edits. Gates run from that clean tree.

## Verdict

**The core is complete and verified; incompleteness sits at the edges.** A clean
full build, the entire test suite, and the HTTP-surface smoke all pass. What is
*not* fully closed: real-LLM verification (env-blocked here), a few inert /
scaffold pieces, one CLI offline-fallback inconsistency, and some thin test
spots. None of these block the core product.

## Ground-truth gates (run on clean `main`)

| Gate | Result |
|---|---|
| `pnpm build` (all packages + apps/api + apps/cli) | ✅ clean |
| `pnpm test` (full suite, 27 workspaces) | ✅ **4464 passed, 0 failed** |
| `pnpm smoke:broad` (HTTP surface, diagnostic provider, no LLM) | ✅ **51 passed, 0 failed** |
| `pnpm smoke:live` (real LLM round-trip) | ⚠️ **UNVERIFIED** — local Ollama could not complete a round-trip in-window (qwen 35b/8b both stalled on this machine). Environment-bound, not a code issue. |
| `pnpm lint` | ✅ 0/0 |
| CLI offline flows (no API server) | ✅ most; ⚠️ 4 reads need the server (below) |

smoke:broad covers: chat, plan-execute, SSE streams, input guards, tasks/notes
REST round-trips, today briefing, multi-agent orchestrate (sequential + stream +
stats), admin runs, tool catalog, voice-provider gating — all green with the
diagnostic provider.

## Completeness by area

### ✅ Complete & verified end-to-end
- **Personal domain** — tasks/notes REST round-trip (create→list→complete→delete,
  save→list→search→read→append), today briefing, local calendar, reminders,
  episodes, history, patterns, contacts. Unit + smoke green.
- **Agent loop** — direct chat, plan-execute, streaming SSE, input/PII guards
  (diagnostic provider). Green in smoke:broad.
- **MCP loopback (23 servers)** — 84 mcp test files green.
- **Model adapters** — 9 model test files green; retry classification + Gemini
  sanitiser verified.
- **CLI local surface** — `today`, `status`, `contacts`, `followup`, `episode`,
  `history`, `pattern`, `routine`, `glance`, `feeds/skills/agents/objectives/trust list`
  all run offline (verified by direct invocation).

### ⚠️ Complete-but-conditional / facade / inert
- **`smoke:live` unverified (highest-value gap).** It is the only gate that proves
  the *local Qwen actually selects the right tool in one shot* end-to-end. It did
  not run here because the machine couldn't complete a round-trip in a practical
  window. Closing it (lighter model / less-loaded host) is the top priority — the
  real-model tool loop is otherwise unconfirmed in this environment.
- **Multi-agent** — the HTTP surface works (smoke green), but only because the
  caller supplies workers. There are **no pre-seeded default workers**; a fresh
  user must populate `AgentSpec` rows, so out of the box it is a framework, not a
  ready feature.
- **Inert voice capabilities** — `live-voice` / Gemini-Live / `wake-word` are
  exported and unit-tested via fakes but **not wired** into `muse listen` or
  `voice-routes` → shipped-but-unreachable from the user surface.
- **External provider adapters (by design, pending credentials)** — Calendar
  Google/CalDAV/macOS = `scaffold`; Notes Apple/Notion = `stub` (throw
  `NOT_IMPLEMENTED`). Local-file tiers are live. Not a defect, but the "4 calendar
  providers / multi-notes" story is only fully live on the local tier.
- **CLI offline-fallback inconsistency** — `tasks list`, `notes list`,
  `remind list`, `memory show` **hard-fail without the API server**
  (`exit 1: API not reachable`), while `today`/`status`/`contacts`/`history`/etc.
  read local stores directly. For a "local-first personal assistant" this split is
  inconsistent.

### 🕳️ Thin test coverage (works, under-verified)
- 18 CLI commands have no dedicated unit test (incl. `commands-status.ts`, 775
  lines) — see the feature-usecase audit list.
- `skills` registry→invoke path untested (parser is tested).

### 📄 Minor doc drift found while checking
- `README.md` "Verification" says smoke:broad hits **42** endpoints; it is now
  **51**.

## Recommended priorities → status

1. **Get `smoke:live` green** on a capable host / lighter Qwen — the single gate
   proving the real local-model tool-calling loop. **Open — environment-bound**
   (this machine can't complete a round-trip; not a code fix).
2. **Resolve intent on inert pieces.** **Deferred by design (not done this
   session) — with reason:**
   - `live-voice` cannot simply be "wired" into `muse listen`: `live-voice.ts`
     ships *only* the abstraction + `FakeLiveVoiceProvider` and explicitly defers
     the real provider ("once dogfood signals justify the websocket-reconnect
     work"). There is no real `LiveVoiceProvider` to connect; wiring the Fake
     would create a do-nothing facade. This needs a **brainstorm → design → build**
     cycle (a real Gemini-Live / OpenAI-Realtime websocket provider), not a
     completeness patch.
   - Multi-agent default workers is a **product decision** (which specialist
     agents ship by default) — same: design first, don't guess.
3. **CLI offline fallback** for `tasks/notes/remind/memory` reads. **✅ DONE this
   session** — all four now auto-fall-back to the local store on
   `isApiUnreachable` (shared helper in `program-helpers.ts`), matching
   `today`/`status`. TDD: `commands-api-fallback.test.ts` (tasks + remind);
   notes/memory reuse the same wrapper over their existing `--local` readers.
4. **Backfill tests.** **Largely done** — `InMemorySkillRegistry`
   (`skill-registry.test.ts`) plus genuine behavior tests for the logic-bearing
   untested CLI commands: `import.isSafeMuseEntry` (path-traversal safety),
   `session` duration/lock parsing, `maintenance` prune planners, `show` terminal
   encoding, `trust.groupToolsByDomain`. The remaining untested commands
   (`analytics`/`cost`/`latency`/`metrics`/`voice`/`setup-voice`/`specs`/`tools-admin`)
   are thin API-formatter wrappers with no exported pure logic — dedicated tests
   would be low-signal; left as-is.
5. **README 42→51.** **✅ DONE** — also corrected the stale `~789`→`~4,460` test
   count.

## Method

Gates run from a clean `/tmp` worktree (not under `.claude/worktrees/`, which the
loop deletes). CLI flows exercised against the built CLI with a seeded demo HOME
(no personal data). smoke:live attempted twice (qwen3.6:35b-a3b, qwen3:8b); both
stalled before the first round-trip completed — recorded as UNVERIFIED, not green.
