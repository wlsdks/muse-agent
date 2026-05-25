# Test-Verification Journal

A separate branch (`worktree-test-verification`) whose sole job is to
hammer the existing Muse codebase with tests, learn from every failure,
and record the *patterns* behind defects — not to ship product features.
Method: observe → reproduce deterministically → root-cause → fix or
document → re-verify.

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
