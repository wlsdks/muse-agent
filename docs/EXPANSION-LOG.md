# Muse Expansion Log — the build journal

> Method (the user's directive, SpaceX-style): **run fast, varied checks; when
> something fails, record the failure and mine it for the next success.** Speed
> of iteration beats a slow perfect run. This file is the running record — what
> was tried, what shipped, what broke, and the lesson taken from each break.
>
> Pairs with [`EXPANSION-PLAYBOOK.md`](EXPANSION-PLAYBOOK.md) (the standing
> brief) and [`goals/CAPABILITIES.md`](goals/CAPABILITIES.md) (the loop's
> capability ledger). Verify fast with
> `node apps/cli/scripts/verify-tool-selection.mjs "<prompt>" <tool>` (one
> local-qwen round, ~1 min) instead of the slow full `pnpm smoke:live`.

## Shipped slices

| # | commit | capability | axis | proof |
|---|--------|------------|------|-------|
| 1 | `73eb9d4b` | proactive nudges due tasks in chat | proactive | unit + cli |
| 2 | `95ca95ab` | morning greeting by remembered name | memory×proactive | unit + cli |
| 3 | `5d6aaf41` | `/remember` shows visible supersede | memory | render |
| 4 | `b3e23a02` | `/forget` substring + ambiguity-safe | memory | unit + render |
| 5 | `b02033ef` | persistent ↑/↓ input history | CLI | unit + render |
| 6 | `37bb4032` | `/memory` surfaces episodic count | memory | unit |
| 7 | `8e111ebf` | `remember_fact` agent tool (NL memory) | memory · model-path | unit + **fast qwen3:8b selection** |
| 8 | `7afb8135` | fast tool-selection verifier + build journal | tooling | self-test PASS |
| 9 | `2506d4a0` | background auto-memory (learn facts without "remember") | memory · model-path | unit + **fast qwen3:8b extraction** |
| 10 | `37a84e61` | show auto-learned facts in chat (trust + undo) | memory · CLI | unit + render |
| 11 | `cda18f85` | auto-memory ignores questions/tasks + patterns doc | memory · hardening | **9/9 live battery** |
| 12 | `76452c1c` | bound persona size (cap facts/prefs) | performance | unit (persona cap) |
| 13 | `32a5211f` | group simultaneous proactive notices (not noisy) | proactive | unit + render |
| 14 | `cfc4dd31` | exclude stale dist test copies from vitest (verification integrity) | hardening | **844→0 dist dupes, 3× green** |
| 15 | `736db083` | re-confirmed facts move to tail so persona cap keeps them | memory · performance | unit (key-order) |
| 16 | `091b67d6` | pin mcp stdio fixture cwd (resolves SDK; closes the "Connection closed" 3) | hardening | mcp 792 green |
| 17 | `6d8f6a39` | retain superseded fact values + show in /memory (temporal depth) | memory depth | unit (store + view) |
| 18 | `bd3b3ad0` | surface fact's prior in persona so the model recalls it | memory depth · model-path | **live qwen3:8b PASS + neg control** |
| 19 | `92649588` | /memory reflects recurring cross-session threads (deterministic) | memory depth · reflection | unit (rank + render) |
| 20 | `2d28d155` | /reflect — grounded LLM synthesis across sessions (fenced vs hallucination) | memory depth · model-path | **live qwen3:8b 3/3 (EN+KO+neg)** |
| 21 | `8263ede3` | proactively open with a reflection once/day (speaks-first) | memory depth · proactive | unit (greeting) + live battery 3/3 |
| 22 | `2f1eb38c` | surface recurring threads in the persona (model references them) | memory depth · model-path | unit + **live qwen3:8b 2/2 (grounded+neg)** |
| 23 | (audit) | memory-depth axis end-to-end composition audit | memory depth · audit | **live qwen3:8b 7/7 compose** |

| 24 | `79cde1ed` | proactively surface imminent calendar events in chat | proactive perception | unit + flow |
| 25 | `e130fba9` | audit: proactive surface composes (sources + dedup + grouping) | proactive · audit | 14/14 compose |
| 26 | `fb85136f` | word-boundary tool relevance (ITR — fewer distractors) | efficiency · model-path | pnpm check green + live selection |
| 27 | `9dd92587` | per-turn skill body injection (ITR — minimal prompt fragments) | efficiency · model-path | unit + **live qwen3:8b 2/2 (follow+withhold)** |
| 28 | `8404db68` | bound active chat history window (Context-Folding) | efficiency · model-path | unit + **live qwen3:8b 2/2 (forget/recall)** |
| 29 | `669d6757` | validate required tool args before execute (deterministic repair) | reliability · model-path | unit + agent-core integration + live |
| 30 | `d1b81f7c` | lossless tool-arg type coercion before execute | reliability · model-path | unit + agent-core integration + live |
| 31 | `810e396a` | add missing "memory" domain keywords → episode/pattern tools reachable | reliability · model-path | unit + **live qwen selects episode.search** |
| 32 | `545ebb3e` | ModelRequest.responseFormat → native structured output (Ollama `format`) | reliability · model-path | unit + **live qwen schema-valid JSON** |
| 33 | `c644ce9c` | reflection uses native structured output (guaranteed JSON) | reliability · model-path | unit + **live battery 3/3** |
| 34 | `1d902216` | auto-memory extraction uses native structured output | reliability · model-path | unit + **live battery 9/9** |
| 35 | `e48ed1a5` | runtime auto-extract hook uses native structured output | reliability · model-path | unit + pnpm check |
| 36 | `9f723f38` | plan-execute uses native structured output (last local JSON path) | reliability · model-path | unit + **live qwen valid plan array** |

### Modern direction: native structured output (constrained decoding) — epic in progress

Direction set after a capability inventory: Muse already has nearly every modern
agent primitive in-house (guards, plan-execute, multi-agent, episodic, checkpoint,
tracing, hooks, output filters, tool-arg repair). The clearest old→modern gap was
structured output — `structuredOutput` was a DECLARED-but-unwired capability;
every JSON path emitted free text + parse-and-hoped (extractJsonObject). Slice 32
wired ModelRequest.responseFormat → Ollama native `format` (JSON Schema =
constrained decoding, guaranteed-valid JSON); slice 33 adopted it in reflection.
Slice 34 adopted it in chat auto-memory, slice 35 in the runtime auto-extract
hook — all three local-model JSON paths (reflection + both auto-memory paths)
now constrained on Ollama. Epic COMPLETE for the local-first goal. Cloud
structured output (OpenAI Responses / Anthropic) is deliberately NOT wired: the
target is a local open-source model (qwen), cloud stays safe via the parser
fallback — wiring paid-LLM-only features would be off-goal. (See the
project-local-first memory note.)

### Internal runtime optimizations already in place (inventory, for reference)
prompt-budget + step-budget (bound prompt/steps), tool-call-deduplicator,
circuit breaker (model-invocation), Anthropic prompt caching (cache_control),
token trimming (context-transforms + memory-token-trim, importance/temporal),
tool relevance + domain filter (26/31), skill-fragment + history window (27/28),
tool-output cap (8k), retry/fallback (retryable classification). NOT done:
parallel tool execution (sequential by design — small model, one-tool-per-turn).

### Efficiency audit correction + a real bug it surfaced (slice 31)

The slice-26-28 audit first measured tool exposure WITHOUT the agent-runtime
toolFilter and reported "~28 tools/turn, big unrealized lever." Re-measuring WITH
toolFilter showed the truth: real exposure is **~6-8 of 79** (planForContext
relevance → toolFilter domain gating) — already within ≤5-7, so the planned
keyword-coverage sweep was NOT necessary. But the re-measure found a genuine
defect: `domain: "memory"` tools (episode/pattern, 9) had no keyword set in
DEFAULT_DOMAIN_KEYWORDS → gated behind a nonexistent list → NEVER exposed. Added
the set; live qwen now selects episode.search on a recall prompt. Lesson: measure
the FULL pipeline before concluding — a partial measurement nearly drove an
unnecessary 48-tool sweep and hid the real one-line bug.

### Reliability from 2026 research — deterministic tool-call repair (slices 29-30)

Structured Reflection (arXiv:2509.18847): formatting/type errors invalidate
otherwise-correct tool calls. Self-Verification Dilemma (arXiv:2602.03485):
small models lose accuracy + tokens from HEAVY self-checking. So the repair is
DETERMINISTIC + cheap, not an LLM verification loop: required-arg validation
(29) returns the missing list so the model re-calls; lossless type coercion (30)
fixes "5"→5 / "true"→true / 42→"42" against the declared schema type, ambiguous
cases left untouched. Both at the executeToolCall seam, before execute.

### Efficiency from 2026 research — tool-selection (ITR, arXiv:2602.17046)

ITR's finding: the biggest one-shot-selection lever on a small model is exposing
only the minimally-relevant tool subset (it reports −95% per-step tokens, +32%
routing). Muse already filters by keyword relevance but on raw SUBSTRING, so
"search"∈"research" leaked distractors. Slice 26 moved to word-boundary matching
with a short inflectional-suffix tolerance (lights⊃light, but research∌search).
Slice 27 applied ITR's OTHER half — minimal system-prompt fragments: skill bodies
are now injected only for the skill relevant to the current turn (others stay a
one-line index), live-proven to still be followed when relevant and withheld
(not hallucinated) when not. Both halves are deterministic retrieval — no extra
model call, pure token/latency savings on the local model.
Slice 28 added the third efficiency lever (Context-Folding, arXiv:2510.11967):
the chat windows its active history to the last N turns (default 40) so a long
session can't grow the per-turn prompt unbounded — live-proven the window
genuinely bounds what the model sees (early fact forgotten under a tiny window,
recalled under a large one). Full transcript still persisted; only the working
set is capped.

### Proactive-perception axis — calendar in the speaks-first tick

Muse now nudges imminent calendar events ("📌 Calendar: Standup (in 15m)"),
grouped with reminders/tasks/followups into one notice; jobs stay separate;
seen-set dedups. Audit (slice 25) confirms all sources compose without spam.

### Memory-depth axis audit — PASS (slices 17–22, qwen3:8b)

`verify-memory-depth-audit.mjs` drives the whole axis as ONE user flow
(supersession store → recurring threads → persona folds prior+threads →
one qwen turn composes BOTH → /reflect insight → /memory view) — 7/7 PASS.
The model answered in a single turn: *"You previously lived in Busan, and
the topic you keep returning to is the Q3 budget."* The pieces compose; no
REOPEN. Kept the script as a composite regression check.

## Failures → learnings

- **Full `smoke:live` timed out (slice 7).** It picked `qwen3.6:35b-a3b` (a big
  MoE) and the run stalled at bootstrap, never reaching the cases. → **Lesson:**
  for a single tool-selection proof, a full smoke sweep is the wrong tool. Built
  `verify-tool-selection.mjs` — one round on `qwen3:8b`, ~1 min, exit 0/1.
  Reserve full `smoke:live` for broad regression sweeps.
- **Raw ESC byte from a heredoc (slices 5, prior).** Writing `"\x1B[A"` landed a
  literal 0x1b in source → repo byte-hygiene test failed. → **Lesson:** use
  `\uNNNN` / `String.fromCharCode`, never a raw control byte; the hygiene gate
  catches it, so run it after any test that embeds escape codes.
- **`JsonObject` imported from `@muse/tools` (slice 7).** Not exported there. →
  **Lesson:** JSON value types live in `@muse/shared`; mirror an existing tool's
  imports before writing a new one.
- **`/forget` table render-test broke (slice 4).** Adding substring resolution
  made `/forget city` resolve against the seeded snapshot; the old exact-key
  test assumed a key that wasn't there. → **Lesson:** when a command gains
  resolution logic, the render tests must seed the memory it resolves against.
- **Stale `dist/` test copies (earlier cleanup).** `tsc` doesn't delete outputs
  for removed sources; vitest then ran a stale dist test. → **Lesson:** `rm`
  orphaned `dist/*` after deleting a source file, then re-run.
- **Auto-extract returned EMPTY on qwen3:8b (slice 9).** The shared
  `pickAutoExtractSystemPrompt` produced valid-but-empty JSON for clear facts
  ("I live in Busan and prefer short answers") — the model was too conservative,
  and the earlier hook success was partly luck. The JSON parser was fine. →
  **Lesson:** the small local model needs a SHARPER, example-bearing
  output-only-JSON prompt. A 4-case fast check (Busan+short / name+job /
  vegetarian / "2+2?"→empty) then extracted reliably. Shipped that prompt in
  chat-auto-memory.ts. Confirms the iterate-fast method: the live MISS, not the
  unit test, found the real gap.
- **Auto-memory stored a fact from a QUESTION (slice 11 diverse battery).**
  "What's the weather in Busan?" → wrongly stored `home_city: Busan`. The 9-case
  EN/KO + negatives battery caught it; the happy-path checks didn't. → **Lesson:**
  add explicit negatives to the prompt ("only DECLARATIVE self-statements; do
  NOT infer from questions/requests" + a weather + a task example). Re-ran → 9/9.

- **The "voice flake" was never a flake — vitest 4 dropped `**/dist/**` from
  its default exclude (risk-resolution).** Every `src`-colocated `*.test.ts`
  compiled into `dist/` was collected TWICE (apps/cli: 844 src + 844 dist), so
  each test ran against possibly-stale compiled code, and the doubled parallel
  /tmp load made the voice-playback cleanup tests time out (the recurring "4
  failed" I kept dismissing). Worse: a fixed bug could "fail" via a stale dist
  copy and a broken src could "pass" — green on outdated code. → **Lesson:** a
  recurring "flake" with a stable count is a signal, not noise — investigate it.
  A major test-runner bump can silently widen what gets *collected*; any
  monorepo compiling tests into an output dir needs an explicit `dist` exclude.
  Fix found pre-documented in a parallel agent's worktree (Finding 001);
  salvaged the config files + TMPDIR-isolation rather than re-deriving.
- **A removed git worktree keeps its branch (risk cleanup).** Two stale agent
  worktrees under `.claude/worktrees/` added duplicate tsconfig roots that had
  broken `pnpm lint` (1814 parse errors). → **Lesson:** `git worktree remove`
  deletes only the working dir; commits stay reachable on the branch, so
  cleanup loses nothing recoverable. Commit a worktree's untracked-but-wanted
  artifacts onto its branch FIRST, then `remove --force`.

- **3 mcp stdio tests "Connection closed" — a cwd-dependent fixture, exposed
  by the dist-exclude fix (slice 14 follow-on).** The fixtures spawn
  `node -e <inline ESM>` that bare-imports `@modelcontextprotocol/sdk`. pnpm
  keeps that dep only under `packages/mcp/node_modules` (not root-hoisted), and
  the vitest worker's cwd is the repo ROOT — so the child couldn't resolve the
  SDK, exited at ~47ms, and the client reported "Connection closed". The 47ms
  (far under the 5s timeout) was the tell: instant death = spawn/resolve
  failure, not a timeout. → **Lesson:** an stdio MCP fixture that bare-imports a
  package MUST pin `cwd` to where that package resolves; never rely on the
  runner's cwd. Reproduce the spawned child standalone (`node -e …` from the
  worker's actual cwd) to see the real ERR_MODULE_NOT_FOUND the SDK masks as
  "Connection closed". Product code was correct — it already honours
  `config.cwd`; only the fixture omitted it.

- **byte-hygiene passes VACUOUSLY for an untracked new file (slice 20→21).** A
  raw ESC byte slipped into a comment in a brand-new test file; the slice-20
  gate ran `pnpm` byte-hygiene BEFORE `git add`, and that test scans
  `git ls-files` — so the untracked file wasn't checked and the byte rode into
  the commit, only failing once the file was tracked. → **Lesson:** for a NEW
  file, run byte-hygiene AFTER `git add` (or stage first), and never hand-type
  an escape-illustrating comment — write the bytes as `\xNN` / `\uNNNN` /
  `String.fromCharCode`. perl `-CSD -pe 's/[\x00-\x08\x0b-\x1f\x7f]//g'` strips
  an already-landed control byte.

- **A live "negative control" can FAIL on the TEST, not the feature (slice 22).**
  Checking "no persona data → no fabrication" first failed: qwen named "Q3
  budget" with no threads in the persona. Two test flaws, not a defect: (a) the
  question was LEADING ("What topic do I keep coming back to?") — it presupposes
  one exists, so a compliant small model invents an answer; (b) both calls
  shared one `userId`, so the runtime's per-user memory/auto-extract bled the
  first (grounded) answer into the second. → **Lesson:** for a no-fabrication
  control, ask a NON-leading question that permits "I don't know", and use a
  DISTINCT userId per live call so runtime memory can't bleed. Fixed → 2/2 PASS.

- **Tightening a fuzzy matcher cuts BOTH false positives and true positives
  (slice 26).** Swapping substring→exact-token relevance killed the
  "search∈research" distractor but ALSO blocked home_action on "turn off the
  lights" (keyword "light" ≠ token "lights") — `pnpm check` caught it in the
  apps/api P17 seam, not the narrow tools test. → **Lesson:** precision and
  recall move together; a word-boundary matcher needs an explicit
  inflectional-suffix tolerance (start-anchored, length-capped) to keep plurals.
  And for a packages/tools (shared-core) change, run `pnpm check` — the consuming
  package's agent-seam test exposes selection regressions the unit test can't.

- **`tsc` catches what vitest's esbuild silently transpiles (slice 28→29).** A
  `(ternary) as const` in a test passed `vitest run` (esbuild strips types
  without checking) but `tsc -p` (the build, run by `pnpm check`) rejected it
  (TS1355) — so the prior commit shipped a type error the package build would
  fail on. → **Lesson:** vitest green ≠ type-correct; for a typed change,
  `pnpm --filter <pkg> build` (tsc) is the real gate, and `pnpm check` runs it
  across the monorepo. Don't use `as const` on an expression — annotate the
  binding instead.

- **Measure the FULL pipeline before concluding (slice 31).** An efficiency
  audit that ran `createWorkspaceToolRoutingPlan` alone showed ~28 tools/turn and
  a "big unrealized lever"; the real runtime also applies `DefaultToolFilter`
  (domain gating) AFTER it → actual exposure ~6-8. The partial measurement nearly
  drove an unnecessary 48-tool keyword sweep AND hid the real one-line bug (a
  domain with no keyword set). → **Lesson:** when auditing a multi-stage path,
  reproduce EVERY stage (here: planForContext → toolFilter); a measurement that
  skips a stage can both invent work and mask the true defect.

## Reusable patterns (carry these forward)

- **Small-model structured extraction:** OUTPUT-ONLY-JSON + concrete examples +
  explicit NEGATIVE examples. qwen3:8b then complies in one shot; vague prompts
  return empty or over-extract. (chat-auto-memory `CHAT_AUTO_EXTRACT_SYSTEM`.)
- **Fast > exhaustive for a single proof:** one local-qwen3:8b round (~1 min)
  beats a full `smoke:live` sweep (the 35b sweep stalled). Build a tiny
  parameterized verifier per concern (`verify-tool-selection.mjs`,
  `verify-auto-memory.mjs`); include EN+KO and negatives. Reserve full
  `smoke:live` for broad regression.
- **Live diverse checks catch what unit tests miss:** unit tests (fake provider)
  passed while the real model over-extracted. A model-path change needs a
  real-model battery, not just unit coverage.
- **Interactive UI is verifiable:** drive `useInput → submit → frame` with
  ink-testing-library (`chat-ink-render.test.ts`) — no PTY needed.
- **Keep model-heavy side effects OFF the reply path:** the runtime's
  afterComplete hook is awaited (blocks). For chat, run extraction in the
  background, cooldown-gated, so the streamed reply stays snappy.
- **Surface autonomous actions for trust:** when the agent learns/acts on its
  own, show it + offer one-tap undo ("📝 remembered: … /forget <key>").

## Open / next experiments

- Memory depth (2026 research, local-fit): ~~temporal validity on facts~~
  (slice 17: superseded values retained + shown in /memory). ~~surface the
  latest supersession to the persona~~ (slice 18: live qwen3:8b answers the
  prior + negative control proves no hallucination). NEXT: reflection/synthesis
  recall — derive a higher-level insight across facts/episodes at recall time.
  Risk: synthesis on a small local model is shaky; prototype with a fast qwen
  battery first and keep it deterministic where possible. (slice 19: shipped the
  DETERMINISTIC cut — recurring cross-session threads in /memory, no LLM. NEXT
  for synthesis: feed those threads to the persona so the model proactively
  references them, OR an LLM "insight" pass — both gated by a fast qwen battery.)
  (slice 20: shipped the LLM "insight" pass as /reflect — the negative case
  PASSED, qwen3:8b stays empty on unrelated one-offs, so the fence holds. NEXT:
  surface a reflection PROACTIVELY at session open when a thread is unresolved,
  not just on demand — reuse the speaks-first system, keep it once-per-day.)
- Performance: persona/context size as memory grows.
- CLI ergonomics + proactive smartness (not noisier).
