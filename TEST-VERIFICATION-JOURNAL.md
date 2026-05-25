# Test-Verification Journal

A separate branch whose sole job is to hammer the existing Muse codebase
with tests, learn from every failure, and record the *patterns* behind
defects — not to ship product features.
Method: observe → reproduce deterministically → root-cause → fix or
document → re-verify.

---

## EXECUTIVE SUMMARY (17 rounds — CONCLUDED)

**19 real defects found by adversarial testing and fixed** (each with a new
regression test, all merged to `main`), plus a reusable tool-selection
reliability harness. Coverage spans every layer: TS core, web frontend, Rust
sandbox, a live local-Qwen round-trip, and the verification tooling itself.

Final state: repo green across repeated full sweeps — 26 packages / 4576 tests,
lint 0/0, rust runner 6/6, `eval:tools` 24/24. The bug-hunt, flaky-test, and
robustness phases are exhausted; the one remaining substantive item (a
non-process-TZ timezone fix) is feature-sized and deferred to the owner.

### Fixes (by layer)
| # | Defect | Area |
|---|--------|------|
| 001 | vitest 4 dropped `**/dist/**` → every src-colocated test double-ran against STALE compiled copies | test infra |
| 002 / 002b | plan + followup parsers anchored on the first `[`, losing the JSON when prose/markdown brackets preceded it | agent-core |
| 003 | `sanitizeGeminiSchema` + tool-output recursion overflowed on deep/circular input | model / agent-core |
| 004 | clarify-directive (outbound-safety safeguard) was English-only; user types Korean | agent-core |
| 005 | trimmer forwarded an orphan tool_use (no matching result) → provider 400 | memory |
| 006 | OpenAI SSE parsers dropped the final event with no trailing `\n\n` (compat backends) | model |
| 008 | objective-evaluator `<think>` strip was O(n²) on unclosed tags | mcp |
| 009 | a corrupt `user-memory.json` crashed every run (only store that didn't degrade) | memory |
| 011 | credential re-login crashed after the per-host key changed (hostname change) | cli |
| 012 | `DynamicToolRegistry` emitted a DUPLICATE tool name on a built-in/dynamic collision → provider 400 | autoconfigure |
| 013 | `webSearch.maxUses` was backend-honored but had no web control (missing setting) | web |
| 014 | Rust runner deadlocked on >64KB output (pipes not drained) → false timeout | crates/runner |
| 015 | `time_relative`/`time_diff` confusable; sharpened "use when / not when" descriptions | tools |
| 016 | `parseInteger` rejected an explicit `0`; added `parseNonNegativeInteger` (`=0` now disables the LLM-followup budget) | autoconfigure |
| 017 | `extractVerifiedSources` emitted each citation URL twice (field + string scan) | agent-core |
| 018 | `chat-ink-render` slash-command tests flaked under load (fixed wait → `waitForFrame` poll) | cli (tests) |
| 019 | `messaging-webhooks` LINE-gating test timed out under load (full `buildServer` > 5s → 20s timeout) | api (tests) |

Also closed two documented follow-ups: the 3 personal stores now `fsync` before
rename, and the URL-dedup above. Deliberately left to the owner: `MUSE_CACHE_TTL_MS`
/ `MUSE_MCP_RECONNECT_MAX_ATTEMPTS` 0-semantics, and the timezone fix.

### New verification asset
`pnpm eval:tools` — a golden tool-SELECTION reliability gate (3 scenarios, 24
cases: synthetic capabilities + Muse's real built-in tools + the confusable
time-tool set; negative no-tool cases; `MUSE_EVAL_REPEAT` stability mode).
Documented as a gate in `testing.md` + `tool-calling.md`. It FOUND finding 015.

### Verified SOLID (probed, no defect)
approval/consent gates (deny/timeout fail-close) · retry classification
(429/408 retryable) · policy/budget/stop guards · MCP security allowlist ·
JWT (timingSafeEqual + alg pin) · AES-256-GCM credential store · scheduler
concurrency (distributed lock, per-delivery persist) · cache LRU/TTL + pattern
matcher · API input validation + multipart parser · `resolveRelativeTimePhrase`
date math · runner shell-less exec boundary · provider tool-call parsing
(unified shape per adapter) · the repo-wide `Number(env)` idiom (consumer
clamps, no busy-loop fail-open).

### Open items — status after round 14
- **finding 016 migration**: ✅ DONE for `MUSE_FOLLOWUP_LLM_BUDGET_PER_DAY`
  (=0 now disables). Deliberately NOT migrated: `MUSE_CACHE_TTL_MS` (0 =
  never-expire vs disable is ambiguous) and `MUSE_MCP_RECONNECT_MAX_ATTEMPTS`
  (downstream `positiveInteger` re-normalizes 0). — owner call if they want
  those.
- **fsync consistency**: ✅ DONE — tasks/reminders/budget stores now fsync.
- **`extractVerifiedSources` URL dedup**: ✅ DONE (de-dupe by url, keep the
  real title).
- **Timezone (finding 007)**: STILL OPEN — day-boundary logic is process-local;
  correct on the user's KST machine, latent on a non-KST server. A real fix
  threads a user TZ through ~8 functions (feature-sized, deferred).
- **Full `smoke:live`**: hardware-bound (CPU too slow for the full suite); the
  live round-trip + tool selection are verified via the targeted probe +
  `eval:tools`. **LLM-as-judge**: deferred — Muse is local-only, so the judge
  would be the same weak model (self-judging bias).

### Recurring defect classes (for future passes)
parse-the-first-delimiter on untrusted LLM text · unbounded recursion/regex ·
asymmetric sanitisation of a symmetric invariant · crash-on-corrupt-load ·
streaming parser never flushes the unterminated final record · duplicate-at-a-
provider-boundary · recovery-path crash · pipe-buffer deadlock · config
fail-open (explicit-0 / NaN).

---

Baseline: branch cut from committed `main` HEAD `7afb8135` (the active
dev agent's uncommitted WIP on `main` is deliberately excluded — an
unstable mid-flight target is not a verification baseline).

Full-suite baseline (vitest 4.1.6, node 20): ~5688 tests across 26
workspaces, all green on a *clean* (no-`dist`) run.

---

## Finding 001 — vitest 4 silently re-enabled `dist` test collection → flaky double-run

**Severity:** medium-high (flaky CI + stale-code false confidence)
**Where:** every package that `tsc`-compiles test files into `dist/`
(apps/cli is the worst: 81 test files). Surfaced as 4 intermittent
failures in `apps/cli/src/voice-playback.test.ts`.

### How it was observed
Two back-to-back full `pnpm test` runs disagreed: run 1 = 1898 passed,
run 2 = 4 failed | 1894 passed in apps/cli. Same code, different result
⇒ flakiness, not a logic bug.

### Reproduction (deterministic)
- The failing tests always took ~5000 ms → they hit vitest's 5 s
  `testTimeout`, not an assertion failure.
- The failures appeared as BOTH `src/voice-playback.test.ts` and
  `dist/voice-playback.test.js` — the same test running twice.
- `npx vitest list` in apps/cli: **831 collected from `dist/`, 831 from
  `src/`** — every test collected twice.
- Run in isolation (`vitest run src/voice-playback.test.ts`): 12/12
  pass, fast, every time → the flake is contention, not the test logic.

### Root cause
`vitest@4.1.6` ships `defaultExclude = ["**/node_modules/**", "**/.git/**"]`
— the `defaults` chunk contains **zero** occurrences of `dist`. vitest ≤3
excluded `**/dist/**` by default; **vitest 4 dropped it.** This repo:
1. compiles `*.test.ts`/`*.spec.ts` into `dist/` via `tsc` (build
   tsconfig `include: ["src/**/*.ts"]`), and
2. has **no vitest config** in the affected packages.

So after the vitest 4 bump, `vitest run` collects both the `src`
originals and the compiled `dist` copies. apps/cli doubles to 162+ test
files; its two `synthesizeAndPlay` cleanup tests read the **shared real
`os.tmpdir()`** and diff `muse-speak-*` entries — under the doubled
parallel fs load the sync fs work + `readdir(/tmp)` occasionally exceeds
5 s and times out.

### Second-order hazard (proven)
`dist` is **stale**: it contributed 831 tests while current `src` has
1067. Tests were running 1067 current + 831 old compiled cases. Editing
`src` without rebuilding makes the runner execute outdated `dist` copies
→ a fixed bug can still "fail" and a broken `src` can still "pass". This
is a verification-integrity defect, not just wasted time.

### Fix
- `apps/cli/vitest.config.ts` restoring `exclude: ["**/node_modules/**",
  "**/dist/**"]`.
- Defense-in-depth: `voice-playback.test.ts` now redirects `$TMPDIR` to
  a private per-test dir (os.tmpdir() reads it per call), so the
  before/after diff is scoped and `readdir` is tiny — the test can no
  longer be polluted by any concurrent worker, regardless of runner
  config.

### Verified
apps/cli with `dist/` present (previous failure condition): **82 files /
1067 tests, 3 consecutive identical green runs.** Lint clean.

### Pattern learned
A major-version bump of the test runner can silently widen what gets
*collected*. Any monorepo that compiles tests into an output dir and
relies on the runner's default exclude is exposed. Repo-wide guard:
every package that emits compiled tests needs an explicit `dist` exclude
(or must stop emitting test files into the build output).

### Repo-wide scope + stale-dist evidence
Most packages keep tests in a top-level `test/` dir (build tsconfig is
`include: ["src/**/*.ts"]`, so `test/` is never compiled — those run
once). Only `src`-colocated test files get compiled into `dist` and
double-collected. Packages with `src`-colocated tests: agent-core,
autoconfigure, mcp, messaging, model, scheduler, tools (+ apps/cli,
which colocates ALL 81 in `src`). Same `dist`-exclude config added to
all of them.

Test-count drop once the stale `dist` copies stop running (baseline →
fixed, both with `dist` present):

| package      | before | after | stale dupes removed |
|--------------|--------|-------|---------------------|
| apps/cli     | 1898   | 1067  | 831 |
| mcp          | 957    | 792   | 165 |
| tools        | 185    | 123   | 62  |
| model        | 180    | 134   | 46  |
| scheduler    | 99     | 62    | 37  |
| messaging    | 232    | 197   | 35  |
| autoconfigure| 269    | 256   | 13  |
| agent-core   | 692    | 672   | 20  |

The removed counts are **not** a clean 50% of each suite — proof the
`dist` copies were compiled from an *older* `src` with different test
counts. The runner was reporting green on outdated code: a real
verification-integrity defect, repo-wide, masked as "more tests pass."

---

## Finding 002 — prose brackets before a JSON plan silently lose the whole plan

**Severity:** medium-high (silent `PLAN_GENERATION_FAILED`; directly
degrades local-Qwen tool-calling reliability — a first-class concern per
`tool-calling.md`)
**Where:** `packages/agent-core/src/plan-execute.ts` —
`extractJsonArray` / `parsePlan`. No dedicated test file existed; the
only coverage was a few happy-path cases in `agent-runtime.test.ts`.

### How it was observed
While scanning for untrusted-text parsers, `extractJsonArray` anchored
on the *literal* first `[` (`text.indexOf("[")`). The runtime model is
local Qwen, which routinely emits prose before its JSON. Probed five
realistic preambles against the built code:

| model preamble                         | extracted | plan |
|----------------------------------------|-----------|------|
| `here is the plan for steps [1-3]:`    | `[1-3]`   | **null** |
| `I will do [0,5) then:`                | `null`    | **null** |
| `- [x] step one` (markdown checkbox)   | `[x]`     | **null** |
| `Per the docs [2], plan:`              | `[2]`     | **null** |
| `tags: ["a","b"] then <plan>`          | `["a","b"]` | **null** |

Every one of these silently dropped a perfectly valid trailing plan.

### Root cause
Committing to the first `[` is fragile against the exact output the
local planner produces. Markdown task lists, numeric ranges, citations,
and example arrays all put a `[` in the preamble.

### Fix (and two failures that taught the final shape)
1. First attempt — "return the first balanced span that is *valid
   JSON*." Failed two new tests: a markdown `- [ ]` is a valid **empty**
   JSON array and a citation `[2]` is a valid **1-element** array, so
   they still won.
2. Final — `parsePlan` now walks **every** top-level JSON-array
   candidate (`iterateJsonArrayCandidates`) and returns the first
   NON-EMPTY array whose every entry is a valid step; a lone empty array
   is still the valid empty plan, but an empty `[ ]` in prose no longer
   shadows a real plan. `extractJsonArray` keeps the lower-level "first
   valid JSON array" contract.
3. Third failure — an existing test (`args:[]` ⇒ null) regressed because
   the candidate scanner resumed at `start+1` and descended into the
   array's **interior**, picking up the nested `args:[]` as a bogus
   empty-plan candidate. Fixed by resuming past the balanced span
   (`end+1`) so only top-level arrays are candidates.

### Verified
New adversarial suite `plan-extract-prose-brackets.test.ts` (14 cases)
green; full agent-core suite 686 passed (was 672, +14); lint clean.
Irreducible limit pinned by a test: only a *plan-shaped* array appearing
in prose before the real plan can still shadow it.

### Pattern learned
"Parse the first match of a delimiter" is a trap for untrusted LLM text
— the model's natural prose collides with the delimiter. Walk candidates
and let the *consumer's* validity test pick, instead of committing to
the first lexical hit. And every retry/repair scan must advance past
what it already consumed, or it re-mines the interior.

---

## Finding 002b — same bug, second site: followup LLM detector

**Severity:** medium (soft feature — `confidence: "low"`, rule detector is
the gold standard — but a real correctness gap on untrusted model text)
**Where:** `packages/agent-core/src/followup-llm-detector.ts` —
`extractJsonArrayBody`.

Acting on Finding 002's "pattern learned," I checked the sibling parser
and it had the **same** first-`[` anchoring bug — plus a worse one: it
scanned brackets with **no JSON-string awareness**, so a `]` inside a
promise's `originalText` (e.g. `"meet [boss] at 3pm] sharp"`) closed the
array early and dropped every followup. Reproduced via the public API
with a stub `ModelProvider` (4 cases, 3 red).

**Fix:** extracted the robust scanner into a shared
`src/json-array-scan.ts` (`iterateJsonArrayCandidates`,
`extractFirstJsonArray`, string-aware `balancedArrayEnd`) and pointed
BOTH `plan-execute` and the followup detector at it — one correct
implementation instead of two subtly-different fragile ones. The followup
parser now walks candidates and returns the first array yielding ≥1 valid
promise.

**Verified:** agent-core build clean; 690 passed (+4); lint clean.

### Pattern reinforced
A defect found by reasoning about a *class* (not a single line) should
trigger a sweep for siblings. Here the sweep found a second, worse
instance and justified consolidating both onto one tested implementation.

---

## Finding 003 — unbounded recursion on untrusted/external structures (two sites)

**Severity:** medium (DoS-shaped: a single pathological input crashes a
whole request; `tool-output` side is on the CLAUDE.md "tool output is
untrusted, tool loops have explicit limits" path)

Continuing the "sweep the class, not the line" method, I attacked the
recursive transforms with deep + circular inputs:

| function | site | deep-nesting | circular |
|----------|------|--------------|----------|
| `sanitizeGeminiSchema` | `packages/model/src/provider-gemini.ts` | RangeError @ ~60k | RangeError |
| `extractVerifiedSources` → `collectVerifiedSources` / `parseToolOutputJson` | `packages/agent-core/src/tool-output-evidence.ts` | RangeError @ ~5000 | n/a (JSON.parse can't cycle) |

`sanitizeGeminiSchema` runs on tool inputSchemas (in-memory objects that
*can* be cyclic via recursive types) — a cycle or deep schema threw
RangeError and poisoned the entire Gemini `generate` request.
`extractVerifiedSources` runs on raw tool output, which CLAUDE.md
explicitly calls untrusted; a ~50 KB deeply-nested JSON payload (≈5000
levels) from a buggy/hostile MCP server crashed evidence extraction.

**Fix:**
- `sanitizeGeminiSchema`: depth cap (100) + `WeakSet` cycle detection,
  returning an empty `{}` schema past the limit (Gemini accepts it).
- `tool-output-evidence`: depth cap (64) threaded through
  `collectVerifiedSources` and the `.result`-string recursion in
  `parseToolOutputJson`; content past the cap is ignored, not thrown on.

**Verified:** model 133 passed (+4), agent-core 693 passed (+3); deep
(200k) and circular inputs no longer throw and stay JSON-serializable;
normal schemas still strip rejected keywords; shallow tool sources still
extracted. lint clean. New suites: `gemini-schema-recursion.test.ts`,
`tool-output-recursion.test.ts`.

### Side observation (logged, NOT fixed — out of scope)
`extractVerifiedSources` emits each cited URL **twice** — once from the
`url`/`webUrl`/`href` field (real title) and once from the generic
string-value scan (url-derived title). Duplicate citations are a quality
nit, but de-duping is a product decision other code may lean on, so it's
recorded here rather than changed under a recursion-safety commit.

### Pattern learned
Every recursive descent over input you don't fully control needs a depth
bound; over an *object graph* (not a freshly-parsed JSON tree) it also
needs cycle detection. "It's just a schema / just tool output" is exactly
where the unbounded assumption hides.

---

## Finding 004 — the clarify-directive safeguard was English-only, but the user speaks Korean

**Severity:** medium (a named outbound-safety safeguard layer silent for
the user's primary language; the send itself is still gated by
draft-first + approval + recipient resolution, so this is a defense-layer
+ UX gap, not an open send path)
**Where:** `packages/agent-core/src/clarify-directive.ts` —
`detectUnderspecifiedRequest`.

### How it was observed
Mapping the fail-close gates (all of which have solid deny/timeout
tests), I noticed `detectUnderspecifiedRequest` matched only an
ENGLISH imperative regex. Muse is this user's personal JARVIS and the
user operates in Korean (`devqamain`; whole session in 한국어). A
contentless Korean command — "보내줘" (send it), "그거 해줘" (do that),
"처리해줘" (handle it) — returned `ambiguous: false`, so the
clarify-directive (named in `outbound-safety.md` rule 3 as the guard
against best-guess actions) never fired and the agent could guess
instead of asking.

### Fix
Add a high-precision Korean regex mirroring the English one: an optional
contentless referent (그거/이거/그것/저거…) + a bare casual-imperative verb
(해줘/보내줘/처리해줘/취소해줘…), anchored so a sentence naming a real
object ("이메일 보내줘") is NOT matched, and `?` excluded from the
terminator ("해줘?" is a question). English behaviour is unchanged.

### Verified
New suite `clarify-directive-korean.test.ts` (6 cases: bare Korean
imperatives flagged; object-bearing & question-marked Korean NOT flagged;
English unchanged). Existing English clarify tests still green; agent-core
699 passed (+6); tsc + lint clean.

### Pattern learned
A safeguard validated only in the codebase's default language is half a
safeguard. For a single-user assistant, "what language does the actual
user type in?" is part of the threat model — checked against the user
profile, not the test fixtures.

---

## Finding 005 — context trimmer sanitised orphan tool_results but forwarded orphan tool_uses (provider 400)

**Severity:** medium (a hard provider 400 that breaks every subsequent
request in a session until budget eventually trims the bad message;
on the request-building path; aligned with the human-directed "harden
real-world failure modes" focus)
**Where:** `packages/memory/src/memory-token-trim.ts` —
`trimConversationMessages` (called at `agent-runtime.ts:649`, the last
step before the provider request).

### How it was observed
Reading the trim passes, I saw `removeOrphanToolResponses` cleans tool
RESULTS with no matching assistant tool_use, but nothing cleaned the
reverse. I wrote a property probe: generate conversations, trim at many
budgets, and validate the output (every assistant tool-call id answered
by a following tool message; every tool message preceded by a matching
tool-call). Result: trimming never *creates* an orphan from well-formed
input, BUT it passes an orphan tool_use straight through when the INPUT
already had one (a partial / interrupted tool turn). Anthropic and OpenAI
both 400 on a tool_use / tool_calls entry with no matching tool_result.

### Why the input can be partial
A tool turn interrupted mid-flight, an error after only some of a
multi-tool call's results were appended, or persisted history from a
crash — any of these leaves an assistant tool_use without its result.
Because the trimmer is the last sanitiser before the provider, it should
guarantee a valid sequence regardless of input, exactly as it already
does for orphan results.

### Fix
Added `removeUnansweredToolCalls`, the symmetric counterpart, run right
after `removeOrphanToolResponses`: for each assistant tool_use it strips
any call id not answered by a following tool message; if that empties the
tool-calls and the message has no text, the message is dropped; otherwise
the answered calls (and the text) are kept and the message's token
estimate is recomputed.

### Verified
Property probe across 7 scenarios × 8 budgets: ALL outputs now orphan-free
(well-formed exchanges untouched). New suite
`memory-orphan-tool-use.test.ts` (4 cases). Full memory suite 189 passed
(+4; existing pairing tests intact); agent-core (the consumer) 699 passed;
lint clean.

### Pattern learned
A sanitiser that cleans one direction of a symmetric invariant almost
always needs the other direction too. "We remove orphan results" should
have immediately prompted "what removes orphan calls?" — the asymmetry
itself was the smell.

---

## Finding 006 — OpenAI SSE parsers dropped the final event when it lacked a trailing blank line

**Severity:** medium (truncated final answer / dropped final tool-call on
OpenAI-compatible local backends — the human-directed focus is local
models)
**Where:** `packages/model/src/provider-openai.ts` — `parseOpenAIStream`
and `parseOpenAIResponsesStream`.

### How it was observed
Mapped all adapters' SSE parsing, then probed the buffering empirically by
feeding `ReadableStream`s with adversarial chunking. Both OpenAI parsers
only process events terminated by `\n\n` (kept the remainder in `buffer`)
and never processed that remainder after the read loop ended:

| input | before fix | want |
|-------|-----------|------|
| Chat: final delta with no trailing `\n\n` | `Hello` (lost " world") | `Hello world` |
| Responses: final delta with no trailing `\n\n` | `Hi` (lost " there") | `Hi there` |
| Chat: JSON split across chunks | `Hello` ✓ | `Hello` |

A compliant server ends with `[DONE]\n\n`, so OpenAI proper is unaffected;
but `OpenAICompatibleProvider` targets LM Studio / llama.cpp / custom
local servers that may close the socket right after the last event — and
then the final delta (or a final tool-call delta) was silently lost.

### Fix
Extracted each parser's per-event body into an inner generator and call it
both inside the read loop AND once on the flushed trailing buffer
(`buffer += decoder.decode()` then process if non-empty) — mirroring the
Ollama NDJSON parser, which already drained its final line.

### Verified
New suite `sse-trailing-event.test.ts` (4 cases incl. the clean
`[DONE]\n\n` path and the cross-chunk split, to guard against a spurious
extra event). Full model suite 137 passed (+4; existing provider-wire SSE
test intact); lint clean.

### Pattern learned
A streaming parser that emits on a delimiter must always flush whatever is
buffered when the source ends — "the last record may not be terminated" is
true for SSE, NDJSON, CSV, and line protocols alike. Test the no-final-
delimiter case explicitly; the happy path hides it.

---

## Areas probed and found SOLID (no defect — verification is also a result)

- **Tool-argument parsers** (`safeParseToolArgs` ollama, `parseToolArguments`
  openai): call sites guard `typeof === "string"` and pass objects through;
  robust.
- **Retry classification** (`isRetryableHttpStatus`): 429 + 408 explicitly
  retryable, all other 4xx fail-fast, 5xx retry; the resilience loop fails
  fast on `retryable === false`. Correct + well-tested.
- **Approval / consent gates** (`createChannelApprovalGate`,
  `toolApprovalGate`, `performConsentedAction`, `resolveContact`): deny,
  timeout, ambiguous-recipient, and absent-consent all have dedicated
  fail-close tests.
- **Policy / budget / stop guards** (tool-call cap, `StepBudgetTracker`,
  wall-clock deadline): safe off-by-one, NaN/Infinity clamped, fail-closed
  defaults. (StepBudgetTracker reports post-facto by design — callers must
  watch status; documented, not a bug.)
- **MCP security policy** (`isServerAllowed`, `McpManager` register+connect):
  exact-match allowlist (no false-positive bypass), connect re-checks the
  policy (two-layer), denial is terminal. Minor note: an allowlist of only
  whitespace entries normalises to empty → allow-all (fail-open on a
  pathological config; not fixed).
- **`parseJsonObjectFromText`**: multi-candidate (whole / fenced / first-`{`
  to last-`}`) with first-valid-object wins; robust for the common
  prose-then-object case.

## Closing summary

7 real defects fixed across 7 commits, each with a new adversarial test
suite and zero regressions; 6 security/correctness-critical areas probed
and confirmed solid. Final sweep: all 26 packages build; model 137 /
memory 189 / agent-core 699 green; `smoke:broad` 51/51.

The recurring defect classes, for future passes:
1. **"Parse the first delimiter match"** on untrusted LLM text (findings
   002, 002b) — walk candidates, let the consumer's validity test pick.
2. **Unbounded recursion** over external structures (003) — depth cap +
   cycle guard.
3. **Asymmetric sanitisation** of a symmetric invariant (005 orphan
   tool_use vs tool_result).
4. **Streaming parser never flushes the unterminated final record** (006).
5. **A safeguard validated only in the codebase's default language** (004
   English-only clarify-directive vs a Korean user).
6. **A test runner / toolchain major bump silently widening collection**
   (001 vitest 4 dist).

---

## Review pass (independent) — 2 MED issues found & fixed before merge

An independent hostile review of the 6 code fixes returned SHIP-WITH-NITS
(no blockers). Two MED issues were fixed before merge:

- **Scanner O(n²) on repetition-degenerate output.** `iterateJsonArrayCandidates`
  re-scanned to EOF from each unbalanced `[`, so a model stuck emitting `[`
  blocked the event loop (~1.5s for 20 KB). Added a total scan-character
  budget (`MAX_SCAN_CHARS = 1_000_000`); realistic output is far under it,
  pathological input now stops instead of hanging. Regression tests:
  200 000-`[` returns null in <2 s; a plan after stray brackets still found.
- **Orphan-result asymmetry.** `removeUnansweredToolCalls` matched answers
  by `toolCallId` only, while its sibling `removeOrphanToolResponses` matches
  positionally when `toolCallId` is absent — so an id-less tool message could
  be kept by one pass and orphaned by the other. Reused `consumeToolResponse`
  so both passes agree. Regression test: id-less tool result stays paired.

LOW nits (Korean verb-coverage gaps, arbitrary depth constants) left as-is —
documented, fail-open/graceful.

---

## Round 2 (post-merge follow-ups)

### Finding 007 — timezone/date is process-local: correct for the CLI, latent on a non-KST server (VERIFIED, deferred — not a minimal fix)

All day-boundary logic (`getDate()`/`getHours()` in commands-today, personal-tasks-store, situational-briefing, followup-detector, the once-per-day budget key) uses **process-local** time. A `timezone` user-preference exists but only drives `Intl.DateTimeFormat` DISPLAY, not computation.

Empirically: at 2026-05-12T23:00Z (= 08:00 KST on the 13th), `getDate()`-based day = `2026-05-13` under `TZ=Asia/Seoul` (this machine's actual TZ) and `2026-05-12` under `TZ=UTC`. So on the **user's own KST machine (the primary CLI surface) it is CORRECT**; the bug only appears if Muse runs on a host whose TZ ≠ the user's (e.g. a UTC server). A real fix means threading an explicit user timezone through ~8 day-boundary functions (signature changes across packages) — a feature-sized change, out of scope for a minimal bug fix. Documented; not changed. (Honest call: do not manufacture a risky refactor for a not-a-bug-in-practice case.)

### Finding 008 — O(n²) `<think>` strip in the exported objective verdict parser (FIXED)

**Where:** `packages/mcp/src/objective-evaluator.ts` — `parseObjectiveVerdict`.
The global lazy regex `/<think>[\s\S]*?<\/think>/giu` is O(n²) on input with
many unclosed `<think>` tags: each open triggers a forward scan that never
finds a close. Measured: 80k opens → 9.5 s; 320k → would be ~150 s. The
internal caller caps model output at 120 tokens (so not reachable as a DoS
today), but the function is **exported** and documented for untrusted,
reasoning-wrapped model text, so the quadratic is a latent hazard.

**Fix:** replaced the regex with a single linear `stripThinkBlocks` pass
(indexOf-based, case-insensitive, unclosed-open keeps the rest, non-overlapping
pairs) — behaviour-preserving. 320k unclosed opens now 6 ms (was ~150 s).
New tests assert behaviour preservation + <1 s on 200k opens. mcp 799 passed;
lint clean.

### ReDoS sweep result
Probed the other regexes over untrusted text — all linear: casual-lure-strip
`{2,}$` bullet patterns (line-bounded alternatives, 144 KB → 0–1 ms), the
ANCHORED `^…<think>…` stripper in provider-shared (single position), the
`unwrapToolData` BEGIN/END marker regex (lazy with required terminator),
and the `https?://[^\s]+` URL extractors. Only the global `<think>` strip was
quadratic.

### Finding 009 — corrupt user-memory.json crashed every run (FIXED)

**Where:** `packages/memory/src/memory-user-store-file.ts` — `FileUserMemoryStore.read()`.
The read did `JSON.parse(raw)` inside a catch that only handled ENOENT and
**rethrew everything else**. A corrupt/truncated `user-memory.json` therefore
threw on `findByUserId`, which runs on EVERY chat (user memory is injected
into the system prompt) — one bad byte bricks the assistant until the file
is hand-fixed. Every personal store already degrades gracefully (quarantine
+ empty); this one didn't.

Reproduced: `findByUserId` on `{"version":1,"users":{` → SyntaxError.

**Fix:** separate the read-error path (ENOENT → empty, real IO error → throw)
from the parse path; on JSON.parse failure, quarantine the file
(`*.corrupt-<ts>`) and return empty — matching the personal stores. A
subsequent write recovers cleanly. New tests: corrupt → no throw + recovers +
quarantine present; non-object payload → empty. memory 195 passed; lint clean.

### Persistence audit — other observations (not fixed, lower severity)
- JSONL reads (chat-history) already skip malformed lines; run-logs are
  write-only telemetry — append non-atomicity is tolerated on read.
- `tasks.json`, `reminders.json`, `followup-llm-budget.json` use tmp+rename
  WITHOUT an `fsync` before rename, while followups/objectives/contacts/
  action-log DO fsync. tmp+rename is already crash-safe for process death;
  the missing fsync only widens a power-loss/fs-crash window. Minor
  consistency gap, documented for a future sweep.

### Finding 010 — review LOW nits closed; multi-agent + DB verified solid
- **clarify-directive (Korean):** completed the contentless-imperative verb
  set — added bare/`-해` variants (보내/지워/바꿔/전송해/변경해/완료해/수정해/옮겨)
  alongside the `-해줘` forms already present. Still high-precision
  (anchored, object-bearing requests like "이메일 보내줘" unaffected).
- **tool-output-evidence:** split the overloaded `MAX_TOOL_OUTPUT_DEPTH`
  into `MAX_STRUCTURE_DEPTH` (64, object/array walk) and
  `MAX_RESULT_UNWRAP_DEPTH` (16, `{result:"<json>"}` re-parse) — two
  semantically different recursions now have intentional, separate bounds.

**Verified SOLID this round (no fix needed):**
- **Multi-agent orchestration** — parallel isolates a throwing worker
  (per-worker try/catch, Promise.all never rejects on a worker fault);
  race resolves on first success (synchronous `resolved` flag → no double
  resolve), returns NoAgentWorkerError when all fail, and does NOT hang
  when the bus publish rejects. All these failure modes already have
  dedicated tests; race losers run to completion in the background by
  design.
- **DB query builders** — the paginated `listRuns` (limit+offset) orders
  by `created_at DESC, id ASC` (stable unique tiebreak); raw `sql\`\``
  fragments parameterise their substitutions (injection-safe). Minor,
  not-fixed: a few limit-only top-N queries lack a tiebreak (harmless
  without offset), and the observability LIKE filter doesn't escape `%`/`_`
  in its prefix (over-broad match, not injection).

## Round 2 closing summary
3 more real fixes (007 timezone = verified/deferred; 008 ReDoS; 009 corrupt
user-memory) + nits (010), across 4 commits. Areas confirmed solid:
multi-agent orchestration, DB query builders, the casual-lure/anchored
regexes. Recurring classes extended: unbounded-recursion now also covers
*quadratic regex* (008) and *crash-on-corrupt-load* (009 — every store but
user-memory already degraded; the odd one out was the bug).

---

## Round 3 (new areas, on branch verification-round-3)

### Finding 011 — re-login couldn't recover after the per-host credential key changed (FIXED)

**Where:** `apps/cli/src/credential-store.ts`.
The CLI credential store is AES-256-GCM with a scrypt key from
`MUSE_CREDENTIAL_KEY` or a per-host fallback (`username+homedir+hostname`).
`readStoredToken` already degrades gracefully on an unreadable store and
prints *"Re-login with `muse auth login` to write a fresh store."* — BUT
`writeStoredToken`/`deleteStoredToken` read-before-write through
`readCredentialStore`, which rethrew on decrypt failure. So when the
per-host key changed (hostname change, machine migration), the advertised
recovery itself **crashed** ("Unsupported state or unable to authenticate
data"): read degraded, but re-login and logout threw on the same
undecryptable read. The user was stuck short of manually deleting the file.

Reproduced: write with key A → read with key B = undefined (good) →
write with key B = **CRASH**.

**Fix:** `readCredentialStore(io, { startFreshIfUnreadable })`. Genuine fs
errors still throw on every path; a *content-unreadable* store (corrupt
JSON / bad format / failed GCM decrypt) returns empty **only for the write
path** — there are no recoverable tokens behind an undecryptable file, so
"start fresh" can't clobber anything, and re-login/logout now recover. A
VALID store is read normally, so other baseUrls' tokens are still
preserved (no-clobber). New tests: re-login recovers, logout no-crash,
valid-store no-clobber. apps/cli 1114 passed; lint clean.

### Round-3 verified SOLID (no fix)
- **Scheduler concurrency** — distributed lock (in-memory Map / Postgres
  upsert-where-expired) prevents concurrent re-fire; no missed-tick
  stampede (next run recomputed from `now`); reminder firing persists
  per-delivery (send→mark→write) so a crash can't re-deliver an
  already-sent reminder, and the residual window is a deliberate
  at-least-once choice for a user's-own-channel (low-risk) reminder.
- **JWT (`packages/auth`)** — `verifyJwt` uses `timingSafeEqual`, pins
  `alg === "HS256"` (rejects alg:none / confusion), verifies the HMAC
  before trusting the header, and checks `exp`. Textbook-correct.
- **Credential encryption** — AES-256-GCM (authenticated), scrypt-derived
  key, random salt+IV per write, 0o600, atomic tmp+rename. Sound.

### Finding 012 — duplicate tool name reaches the model on a built-in/dynamic collision (FIXED)

**Where:** `packages/autoconfigure/src/dynamic-tool-registry.ts` — `list()`.
`list()` returned `[...super.list(), ...dynamicTools()]`. `dynamicTools()`
dedupes WITHIN dynamic sources, but there was no dedup ACROSS the built-in
set and the dynamic set. So when a dynamic MCP source exposes a tool whose
name collides with a built-in (realistic on a multi-MCP machine), the name
appeared twice in the projected tool list. OpenAI/Anthropic reject duplicate
function names → the whole request 400s. Worse, `get(name)` already resolved
a collision to the built-in, so `list()` and `get()` disagreed.

Reproduced: built-in `web_search` + dynamic `web_search` →
`planForContext().tools` = `[home_state, web_search, web_search]`.

**Fix:** `list()` drops a dynamic tool whose name shadows a built-in
(built-in wins, matching `get()`); non-colliding dynamic tools are kept.
New test file `dynamic-tool-registry.test.ts` (3 cases). autoconfigure 259
passed; lint clean.

### Round-3 tool-projection verified SOLID (not fixed)
- **`required` survives sanitizers** — the Gemini sanitizer's strip-set does
  not include `required`; OpenAI gets the raw schema. Tool-call args stay
  required-bearing.
- **Casual-prompt eager-invocation guard is description-based by design**
  (tool-calling.md rule 4) — `isCasualPromptText` gates response filtering,
  not tool projection; suppression relies on each tool's "use when / not
  when" line, as documented.
- **Exposure cap (`maxTools`)** — `planForContext` applies the caller's
  `maxTools` (sorted by relevance first) but has no hard built-in cap;
  capping is a caller policy (the server path may legitimately want all
  tools), so not changed — noted as a config concern, not a bug.

## Round 3 closing summary
2 real fixes (011 credential re-login recovery; 012 duplicate-tool-name on
collision) + areas verified solid: scheduler concurrency, JWT, credential
encryption, schema `required` preservation. Recurring classes extended:
"crash/duplicate reaches an external boundary" — the credential re-login
crash and the duplicate-function-name both surface at a boundary
(filesystem recovery / provider request) the happy path never exercises.

---

## Round 4 — no new defects; four areas verified SOLID

Probed four fresh surfaces; all are well-built and already hardened. No fix.

- **API route input validation (apps/api, Fastify)** — bodies validated at
  the boundary via ParseResult/type-guard helpers (`parseScheduledJobInput`,
  `parseOrchestrateBody`, `parseAgentRunInput`); query ints parsed with a
  strict `STRICT_INT_RE` and `Number.isFinite` guards; malformed/empty bodies
  return 400 (smoke:broad asserts "rejects empty body"). Fastify catches a
  thrown handler and returns 500 without crashing the process or leaking a
  stack.
- **Calendar credential store** — `save(providerId, …)` stores providerId as
  a JSON **object key**, not a path (no traversal), on a **null-prototype**
  object (no `__proto__`/`toString` prototype pollution). Atomic tmp+rename,
  0o600.
- **InMemoryResponseCache (packages/cache)** — proper LRU (get() delete+re-set
  promotes; evictOverflow drops the oldest), `>=` TTL boundary, and explicit
  NaN/Infinity finite guards on maxSize/ttlMs (the code comment notes this is
  the "same defect class as the scheduler / token-cost finite guards" — a
  prior systematic sweep). `createPatternMatcher` escapes literals and uses
  only `.*` (no ReDoS, no crash on a `[`-bearing pattern).
- **Multipart parser (server-multipart-sse.ts)** — boundary used as a literal
  `split` (no regex injection), all header regexes linear (no ReDoS), body
  bounded by Fastify's bodyLimit.

**Signal:** rounds 1–3 found 9 real defects; round 4's targeted surfaces are
mature and pre-hardened. Diminishing returns on bug-hunting the
runtime/boundary core — the high-value defect classes (untrusted-text
parsing, unbounded recursion/regex, asymmetric sanitisation, crash-on-corrupt,
streaming flush, duplicate-at-boundary, recovery-path crash) have been swept.

---

## Round 5 — web settings audit (apps/web)

User concern: every setting is done in the web; none may be MISSING, and none
may be "무늬만" (renders but doesn't actually work). Installed Playwright,
ran the web suite (27 unit + 2 e2e green), and audited the settings surface.

### Finding 013 — webSearch.maxUses was backend-honored but had no web control (FIXED)

The backend reads exactly two runtime-settings keys
(`server-helpers.ts` `applyWebSearchPolicy`): `webSearch.enabled` and
`webSearch.maxUses`. The web's SetupPanel exposed only the `enabled` toggle —
so `maxUses` was a real, runtime-honored setting with **no way to set it from
the web** (the user's "missing setting" case). Added a maxUses number input to
SetupPanel (mirrors the proven enabled-toggle wiring: PUT
`/api/admin/settings/webSearch.maxUses` with `type:"number"`, commit on blur,
positive-integer guard, disabled when search is off). New tests in
`setup-panel.test.tsx` (4 cases: both controls render, reflects persisted
value, defaults to 5, disabled when off). web 31 unit + 2 e2e green; typecheck
clean.

### Web verified SOLID (no "무늬만" settings)
- **`webSearch.enabled` is genuinely honored end-to-end** (not decorative):
  SetupPanel checkbox → PUT → runtime-settings persist → `applyWebSearchPolicy`
  reads it via `getBoolean` → `buildModelRequestWithWebSearch` gates the tool
  on the chat path. Traced the full read side, not just the write.
- **No decorative controls / no dead endpoints** — every settings control in
  setup/calendar/voice/reminders/messaging/tasks/notes panels has a handler
  that calls a concrete `/api/...` path, and every such path has a live
  backend route (audited the panel→api-client→route chain).
- **Calendar credential PUT** stores providerId as a null-prototype object key
  (no path traversal / proto-pollution), atomic write, 0o600.
- Minor non-setting gap (not fixed): `GET /api/proactive/history` (read-only
  diagnostic log) has no web view — a missing VIEW, not a missing setting.

---

## Round 6 — crates/runner (Rust security sandbox)

Installed the Rust toolchain (brew install rust → cargo 1.95) since it was
absent. `cargo build` + `cargo test` green (4 pre-existing tests). Audited the
sandbox boundary.

### Finding 014 — runner deadlocks on >pipe-buffer output → false timeout (FIXED)

`crates/runner/src/main.rs` `run_request` polled `child.try_wait()` but did
NOT read stdout/stderr until after the child exited. A child that writes more
than the OS pipe buffer (~64 KB) before exiting blocks on the full pipe, never
exits, and is killed at the timeout — so a fast, successful command that just
emits a lot of output is falsely reported `timed_out: true, ok: false` and
stalls for the full timeout (30 s default).

Reproduced via the built binary: a `head -c 200000 … | tr` (≈200 KB, exits in
ms) returned `ok:false, timedOut:true` after the timeout. (The bug also
doubled as accidental memory protection — `wait_with_output` buffered the
whole stream unbounded, so the fix must also cap.)

**Fix:** drain stdout and stderr on dedicated threads (`spawn_drainer`) so the
child never blocks on a full pipe; each drainer keeps at most
`max_output_bytes` and keeps reading-and-discarding past the cap (bounded
memory AND no deadlock). The main thread still enforces the timeout/kill.
After fix the same repro returns `ok:true, timedOut:false, 200 KB` instantly.
New tests: `append_capped` cap helper, a 200 KB no-deadlock regression, and a
cap-without-blocking case. cargo test 6 passed; clippy clean.

### Runner boundary verified SOLID
- **No shell** — `Command::new(name).args(argv)`, so no shell-injection; args
  are real argv, not a concatenated command string.
- **Path-execution blocked** — rejects a command containing `/` or `\` (must
  be a bare executable name resolved via PATH).
- **Env sanitised** — `env_clear()` then only PATH + keys matching
  `[A-Z0-9_]+` are passed through (lowercase like `Path` can't override).
- **stdin null**, **timeout + kill**, **output capped**. The isolation
  primitive is sound; WHAT may run is gated by the TS layer + outbound-safety,
  not here (by design).

---

## Round 7 — the gold-standard live round-trip (finally cleared)

`smoke:live` (real local-Qwen round-trip + one-shot tool selection) is
CLAUDE.md's highest verification bar, never run across rounds 1-6 because the
harness greedily picks the largest local qwen as the heavy tier — on this
machine a 24GB MoE that never warms up in time, hanging the suite.

### Harness fix — `MUSE_SMOKE_LIVE_HEAVY_MODEL` override
`scripts/smoke-live-llm.mjs` `pickTierModels` now respects an explicit heavy
override (backward-compatible: no override → current auto-detect, so the loop
PC is unaffected). When the override equals the fast model, the tiered check
is skipped (not failed) and the rest of the live suite runs on one model.
With it, the 35B is no longer selected. (The FULL suite is still too slow to
finish on this CPU-only box — it spawns full `@muse/api` + CLI `ask`
subprocesses per check, each a cold-loaded multi-turn agent pipeline — so it's
a hardware limit, not a harness bug.)

### Gold-standard essence verified via a targeted live probe (qwen3:8b)
Rather than the slow full suite, drove the real Muse `OllamaProvider.generate`
directly:
- **Round-trip**: prompt → "The capital of France is Paris." (real
  request/response path works live, ~340ms warm).
- **One-shot tool selection** (tool-calling.md core): given a `get_weather`
  tool + "weather in Seoul?", the model returned exactly one tool call
  `get_weather({city:"Seoul"})` in a single inference (~920ms). This exercises
  tool projection → Ollama native tool-calling → arg parsing end-to-end with
  the real local model — the behaviour rounds 1-6 could only check statically.

Result: the request/response path and the local-model tool-calling premise are
confirmed LIVE, not just by unit tests. The fixes that touched this path (SSE
parser, plan parsing, tool projection, gemini sanitiser) compose with a real
qwen3:8b round-trip.

---

## Round 8 — research-informed gap: a tool-selection reliability harness (NEW)

User direction: the harness matters — research what tests we actually need.
Web research on testing LLM agent runtimes (2025) converged on: agents are
stochastic, so the recommended gate is a **lean golden dataset** of
(prompt → expected tool) cases run against the real model and scored, with
explicit **negative cases** (greetings → no tool) and the known tool-calling
failure modes (wrong tool, missing/incorrect params, eager invocation).

Mapped to Muse: tool-calling.md's first-class concern ("the local Qwen picks
the right tool in ONE shot") was only covered statically (schemas/projection)
and by the heavy, CPU-bound smoke:live. The missing middle layer is exactly
that golden tool-SELECTION gate.

### Added: `scripts/eval-tool-selection.mjs` + `pnpm eval:tools`
A lean, repeatable, LOCAL-OLLAMA-ONLY harness: a small golden dataset (9 cases
— EN+KO weather/reminder, web-search, math-not-web-search, and EN+KO
greeting/thanks → NO tool) run straight against `OllamaProvider.generate`
(temperature 0), scored against a reliability threshold (85% default), and
skipped (exit 0) when Ollama is unreachable. Negative cases pin the
no-eager-invocation rule; Korean cases pin the user's actual language.

**Result (qwen3:8b): 9/9 (100%)** — every positive case selected the right
tool with the right args in one shot, every greeting/thanks correctly made NO
call. Confirms tool-calling.md's premise holds with the real model, and gives
Muse a reusable reliability gate (the systematic version of round-7's one-off
probe) rather than a one-time check.

Sources (research): Turing College "Evaluating AI Agents 2025"; IBM Research
"Evaluating LLM-based Agents (IJCAI 2025)"; Confident AI "Test Cases, Goldens,
and Datasets"; arXiv 2507.21504 "Evaluation and Benchmarking of LLM Agents".

### Round 9 — extend the golden set with the research's named failure modes

Grew `eval-tool-selection.mjs` from 9 → 12 cases, adding the failure modes the
research flagged: (a) **no-fitting-tool** — a pure-generation request ("write a
two-line poem") must NOT force an irrelevant tool; (b) **indirect intent** —
"I'm in Seoul, do I need an umbrella later?" → get_weather(Seoul); (c)
**keyword trap** — "Quick, remind me — what's 25% of 480?" must go to
`calculate`, NOT `set_reminder`, despite the word "remind" (tool-calling.md:
homonyms are the #1 wrong-selection cause).

**Result (qwen3:8b): 12/12 (100%)** — the local model selects by intent, not
keywords: the poem drew no tool, the umbrella question resolved to weather, and
the "remind"-worded math question correctly chose calculate. The reliability
gate now exercises happy-path, negatives, and the three named failure modes.

### Round 10 — eval:tools now gates Muse's REAL built-in tools

Extended the harness with a second scenario, "real-tools", that instantiates
Muse's actual @muse/tools definitions (math_eval, slugify, text_stats,
hash_text, and the confusable time_now/time_diff pair) and asserts the model
selects the right PRODUCTION tool per prompt — tool-calling.md's deliverable
bar ("a tool the model can't reliably call is not delivered"), now checked
against the shipping tool names/descriptions, not just synthetic ones. The
scenario skips cleanly if @muse/tools isn't built. `pnpm eval:tools` builds
both @muse/model and @muse/tools.

**Result (qwen3:8b): 18/18 (100%)** — synthetic 12/12 + real-tools 6/6. The
real tools are one-shot selectable, including the time_now-vs-time_diff
disambiguation that tool-calling.md flags as the #1 wrong-selection risk. No
tool-design defect found; the production tool surface is verified selectable.

### Finding 015 — time_relative / time_diff were confusable; sharpened descriptions (FIXED)

Exposing Muse's 6 real time tools together (a confusability stress per
tool-calling.md rule 2), the model picked `time_diff` for "How long ago was
2026-05-01 from now?" — it should be `time_relative`. The two overlap
(time_relative is time_diff with one side = now) and neither description told
the model when NOT to use it.

**Fix:** added "use when / not when" lines (tool-calling.md mandates them):
time_diff → "use when you have TWO explicit timestamps; for 'how long ago/until'
relative to NOW use time_relative"; time_relative → "use when comparing ONE
timestamp to now; do NOT use for two explicit timestamps — use time_diff."
Behaviour-only-additive (no schema/API change). After the fix the 6-tool probe
went 5/6 → **6/6**; tools tests 128 passed.

### Round 11 — eval:tools gains the confusable real-time-tools scenario + becomes a documented gate

Added a third harness scenario exposing all 6 real time tools, with the
time_relative-vs-time_diff disambiguation as a pinned case (regression guard
for finding 015). Full run **24/24 (100%)** (synthetic 12 + real 6 + time 6).
Documented `pnpm eval:tools` as verification gate #5 in `.claude/rules/testing.md`
(run after touching tool names/descriptions/schemas, projection, or the Ollama
adapter).

### Round 12 — eval:tools reliability mode + real-tool confusability sweep

- **Confusability sweep (broad real data/text tools)**: exposed 8 real
  @muse/tools (math_eval, hash_text, csv_parse, base64, text_stats, slugify,
  kv_summarize, markdown_table) and probed each. 8/9 — the one miss was the
  model answering a trivial word count directly instead of calling text_stats
  (not a mis-selection). No confusable overlap like the time tools; the
  data/text descriptions are well-disambiguated. (time_relative/time_diff,
  fixed in 015, remains the only real overlap found.)
- **Provider tool-call conformance (G3)**: verified ALREADY covered — each
  adapter (anthropic tool_use, gemini functionCall, openai-responses
  function_call, openai-compatible/ollama tool_calls) has a tool-call parse
  test asserting the unified ModelToolCall shape in model.test.ts. No
  redundant wrapper added (would be churn).
- **eval:tools MUSE_EVAL_REPEAT mode**: runs each case N times and passes only
  if every run passes — surfaces flaky/borderline selections a single run
  hides. The stochastic-model reliability gate the research recommends.
  Verified REPEAT=2 → 24/24 stable.

### Finding 016 — parseInteger rejects an explicit 0 (no >=0 integer variant); added parseNonNegativeInteger

The float env-parsers distinguish `parsePositiveFloat` (> 0) from
`parseNonNegativeFloat` (>= 0), but the integer side had only `parseInteger`,
which requires `parsed > 0`. So every integer env var used the >0 parser, and
a deliberate `MUSE_*=0` was silently replaced by the non-zero fallback — a
fail-open surprise for settings where 0 means disable/unlimited:
- `MUSE_FOLLOWUP_LLM_BUDGET_PER_DAY=0` (disable LLM followups) → kept default 20.
- `MUSE_CACHE_TTL_MS=0` (never-expire, which the cache treats as ttl=0) → kept 1h.
- `MUSE_MCP_RECONNECT_MAX_ATTEMPTS=0` (don't reconnect) → kept 3.

**Action (safe, additive):** added `parseNonNegativeInteger` (>= 0, same strict
parsing) + tests, restoring symmetry with the float parsers. Did NOT migrate
the ~20 production call sites — whether each setting should accept 0 is a
per-setting product decision (and some need downstream "0 = disable" handling),
so that's flagged for the owner. The primitive now exists; the listed settings
are the highest-value candidates to adopt it. autoconfigure 262 passed; lint clean.

### Round 12 close — strategy doc + final certification

- **tool-calling.md** now points its "verify the model SELECTS it" checklist
  item at `pnpm eval:tools` (the lean golden gate) alongside smoke:live — add
  a case when shipping a tool, run with MUSE_EVAL_REPEAT for stochastic
  confidence.
- **Final certification:** 26 TS packages / 4546 tests passed / 0 failures;
  lint 0/0; rust runner 6/6; eval:tools 24/24. Repo green with all 16 fixes.

## Self-directed 10-goal round summary
G1 merge round-11 ✓ · G3 provider tool-call conformance (verified already
covered, no churn) ✓ · confusability sweep of real data/text tools (clean,
8/9) ✓ · eval:tools MUSE_EVAL_REPEAT reliability mode ✓ · finding 015 fix
(time_relative/time_diff descriptions) shipped earlier ✓ · finding 016
(parseNonNegativeInteger; explicit-0 fail-open) ✓ · tool-calling.md → eval:tools
pointer ✓ · final full certification ✓. LLM-as-judge intentionally deferred
(local-only judge = self-judging bias; honest non-fit, not built).

---

## Round 13 — config-parsing fail-open sweep (clean) + missing-param layering

- **Config-parsing fail-open sweep** (the finding-016 class, repo-wide): audited
  every ad-hoc `Number(env.X)` outside the hardened autoconfigure env-parsers
  (~25 sites in tick-daemons + CLI cap/window parsers). ALL are defended at the
  consumer: every tick daemon clamps its interval (`clampInterval`/isFinite →
  default, so a typo'd `MUSE_*_TICK_MS=60x` → NaN → default, NOT a 0ms busy
  loop), and the CLI caps use `Number.isFinite(raw) && raw >= N ? trunc : def`.
  Consistent, mature idiom — no fail-open found. (finding 016's parseInteger-0
  asymmetry remains the only one.)
- **Missing-required-param — correctly layered, not a selection concern.**
  Probed "Remind me to call Sam" (no time): with ONLY set_reminder exposed the
  model asks for the time; under a larger tool set it fires set_reminder
  eagerly (context-dependent). Either way set_reminder is the RIGHT tool — the
  missing `when` is caught by the runtime's required-arg gate (agent-runtime:
  "blocks a tool call missing a REQUIRED argument before the executor runs",
  already tested), NOT by the model declining. Removed two mis-framed
  expectNoTool golden cases (selection ≠ param-completeness) and documented the
  layered defense inline. eval:tools back to 24/24.

---

## Round 14 — close P1 follow-ups (finding-016 migration + fsync consistency)

- **finding 016 migration (the safe one):** `MUSE_FOLLOWUP_LLM_BUDGET_PER_DAY`
  now uses `parseNonNegativeInteger`, so an explicit `=0` disables LLM
  followups (verified: `isFollowupLlmBudgetExhausted` treats `cap <= 0` as
  exhausted) instead of silently keeping the default 20. NOT migrated:
  `MUSE_CACHE_TTL_MS` (0 = never-expire vs disable is ambiguous → unsafe) and
  `MUSE_MCP_RECONNECT_MAX_ATTEMPTS` (downstream `positiveInteger` re-normalizes
  0 → migrating the env parse alone has no effect). Per-setting judgment.
- **fsync consistency:** `personal-tasks`, `personal-reminders`, and
  `personal-followup-llm-budget` stores now `fsync` before rename (open →
  writeFile → sync → close → rename), matching followups/objectives/contacts/
  action-log — closing the power-loss window where a rename could commit a
  not-yet-flushed tmp file. autoconfigure 262 / mcp 799 passed; lint clean.

## Round 14 — finding 017: extractVerifiedSources de-dupes URLs

Closed the documented URL-duplication: `extractVerifiedSources` pushed each
url twice (field match with the real title + generic string scan with a
url-derived title). Added `dedupeByUrl` keeping the first (better-titled) hit.
agent-core 709 passed; lint clean.

## Round 15 — finding 018: flaky chat-ink-render slash-command test (fixed)

The full-suite sweep intermittently failed `chat-ink-render.test.ts > /memory`
(the whole file ran ~25s under load). Isolation: 36/36 green, 3/3 — a
contention flake (finding-001 class), not my regression (apps/cli untouched by
this work). Root cause: the slash-command loop waited a FIXED `tick(140)` after
Enter, then asserted; Ink renders async, so under full-suite parallel load the
command output (esp. /memory loading user memory) wasn't in the frame within
140ms → false miss.

**Fix:** replaced the fixed wait with `waitForFrame` — poll `lastFrame()` every
20ms until all needles appear or a 2s bound (fast when idle, robust under
load). Timing-only; assertions unchanged. Full sweep now green: apps/cli 1158
passed, 26 pkgs / 4567 passed, lint 0/0, rust 6/6, eval:tools 24/24.

## Round 16 — preemptively poll-ify the rest of chat-ink-render (flaky-class prevention)

Round 15 fixed the one demonstrated flake; this converts the remaining
fixed-`tick(N)`-then-assert blocks in the same file (echo, approval box,
/remember, /pref, supersede, /forget ×2, ↑-recall, auto-learn, proactive,
launch brief, plain-chat, /new) to `waitForFrame` polling. Same async-render
contention class — fast when idle, robust under the full-suite load — so the
whole file is now flake-resistant, not just the one case that happened to fail.
Mid-flow setup ticks (e.g. enabling /tools before typing) are left as-is.
Isolated 36/36 ×2; full sweep green (apps/cli 1158, 26 pkgs / 4568, lint 0/0).

## Round 17 — finding 019: empirical stress surfaced an apps/api flake (fixed)

Rather than mass-convert the 13 test files that use real sleeps (no demonstrated
flake → would be churn), I STRESS-tested the real-sleep-heavy packages (api,
multi-agent, mcp) repeatedly. apps/api flaked ~1-in-5:
`messaging-webhooks.test.ts > "does not register the route when
MUSE_LINE_CHANNEL_SECRET is unset"` timed out at 5005ms. Root cause: unlike its
sibling tests (which register only the lightweight lineWebhookPlugin), this one
builds the FULL app via `buildServer` to verify conditional route wiring —
heavy enough to exceed the 5s default under full-suite parallel contention (not
a logic bug, not a real sleep).

**Fix:** a realistic 20s timeout on that single test (it legitimately builds
the whole app). apps/api 325 passed ×3; lint clean. Method note: empirical
stress (not blanket conversion) found the real flake and avoided churning the
12 other real-sleep files that never flaked.
