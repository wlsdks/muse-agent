# Loop journal — multi-agent (오케스트레이션·서브에이전트 핸드오프 신뢰성)

Theme: lead-worker orchestration / sub-agent handoff reliability (MAST coordination-failure
guards · handoff schema validation · explicit termination). Worktree `/tmp/muse-multi-agent`,
branch `loop/multi-agent`. Tier2 (push every fire; merge-to-main every 3rd fire).

## fire 15 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · d08bb006
meta: value-class=wiring(exposure-completion) · pkg=@muse/cli · kind=human-stderr-surfacing · verdict=PASS · firesSinceDrill=3
ratchet: testFiles +0 (cases added to commands-ask.test.ts) · fabrication 0 · eval:orchestration PASS · DIVERSE-kind (human-stderr vs fire-14 json) · calibration-aware

**What** — Completed the HUMAN exposure of the fan-in coordination signals (the symmetric twin of fire 14's
`--json` fix). The `muse ask` stderr banner warned on CONTRADICTIONS (`subtaskConflicts`) but was blind to
REDUNDANCY. Extracted a PURE, testable `decompositionStderrNotes(decomposed)` (the inline god-file prints aren't
testable — same extraction pattern as fire-14's `decompositionJsonFields`) that builds the human warning lines:
CONFLICT (preserved byte-identical) + REDUNDANCY (new — a near-identical pair means the synthesis may over-weight
a point, correctness-adjacent). The call site replaced the inline print with a loop over the function.

**Why / ★CALIBRATION** — Deliberately does NOT surface `reasoningActionGaps` to the human: that lexical signal
was MEASURED (fire 10) to over-fire on legitimate paraphrase/decide downstreams (6/6 transforms), so a prominent
⚠️ on most sequenced runs would erode trust. It stays `--json`-only (fire 14) where a consumer can weight it.
Surface the PRECISE signal to the human; keep the NOISY one machine-only. `ℹ` (info) vs `⚠️` (warning) glyphs
right-size severity.

**Review points** — (1) MUTATION-FIRST: removing the redundancy push → the redundancy + conflict+redundancy
tests RED (2 failed), restored. (2) BYTE-IDENTICAL conflict line (judge verified: fn returns `…:\n${map join}`,
caller adds `\n` = old inline exactly; no double-newline, empty-conflicts → no note → no empty line). (3) Pure
function → testable (god-file testability gain). (4) No collateral (sibling prints + decompositionJsonFields
untouched).

**Risk** — Pure additive surfacing; no model/egress, floor untouched. The exposure layer (engine→result→stderr→
JSON→run-log) is now COMPLETE for the precise signals. Weakest point (judge): tests use `.includes()` not
full-equality, so they don't lock the exact wording vs future drift (preservation is correct now). Theme: the
exposure gap fires 14-15 closed was real; the core orchestration guards remain mature.

review: gates green — cli build clean · decompositionStderrNotes 5 pass · lint 0 · `pnpm check` exit 0 (one
@muse/model fuzz flake, passed on re-run) · eval:orchestration PASS · independent Opus ④ judge VERDICT PASS.

## fire 14 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 25f5f6d1
meta: value-class=wiring(gap-fix) · pkg=@muse/cli · kind=json-serialization · verdict=PASS · firesSinceDrill=2
ratchet: testFiles +0 (cases added to commands-ask.test.ts) · fabrication 0 · eval:orchestration/decomposition PASS · DIVERSE (cli/json-serialization, not multi-agent package) · ★found a REAL gap the fire-11/13 exhaustion claim MISSED

**What** — `decompositionJsonFields` (the `muse ask --json` + run-log trust-signal serializer) emitted only
`subtaskConflicts` + `synthesisIncomplete`, OMITTING `subtaskRedundancies` (fire 7) and `reasoningActionGaps`
(fire 10) — two coordination signals already computed in production and carried on `DecomposedAskResult`, but
never serialized. A `--json` machine consumer was BLIND to worker-duplication (MAST step-repetition) and
blind-step (FM-2.6) coordination failures while seeing a clean `groundedVerdict` (a GROUNDED≠TRUE-adjacent
leak). Added both to `DecompositionTrustSignals` + emitted them (mirroring the conflicts pattern, empty-array
guarded). The judge verified the SAME `decompositionSignals` value feeds BOTH the --json payload AND the
run-log, so one fix covers both surfaces.

**Why** — Sibling-audit completion of fires 7/10: they wired the signals to the result + the human stderr, but
missed the MACHINE serialization layer. This closes it.

**Review points** — (1) MUTATION-FIRST: the new test RED before the emit lines (the JSON omitted the arrays),
GREEN after; judge re-ran the mutation. (2) Faithful mirror (empty-array `.length > 0` guard, single-run path
still `{}`). (3) The 2 fields are real production data (lead-worker.ts → ask-decompose.ts:191-192 pass-through),
not phantom. (4) Completeness: judge traced both consumers (run-log + --json) go through this one function — no
other omitting site.

**Risk** — Pure additive serialization; no model/egress, floor untouched. ★LESSON: do NOT declare a theme
"exhausted" without checking the SERIALIZATION/EXPOSURE layers — fires 11/13 no-shipped on "exhausted" but a
real gap (the JSON serializer omitting 2 signals) was sitting in the cli exposure layer. A signal added to a
result object must be sibling-audited through to EVERY surface that serializes it. DEFERRED (still): the HUMAN
stderr surfacing of redundancies/reasoningActionGaps (commands-ask prints the conflicts ⚠️ line only — god-file,
untestable, the fire-4 blocker). Theme is still mature but NOT fully exhausted — the exposure layer had a gap.

review: gates green — cli build clean · decompositionJsonFields 4 pass · lint 0 · `pnpm check` exit 0 ·
eval:orchestration/decomposition PASS · independent Opus ④ judge VERDICT PASS.

## fire 13 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · NO-SHIP (theme exhausted — 2nd; repoint still pending)
meta: value-class=none(no-ship) · pkg=none · kind=theme-exhaustion · verdict=NO-SHIP · firesSinceDrill=1
ratchet: testFiles +0 · fabrication 0 · self-eval green (regression sentinel held) · no source

**What** — ⓪ sync + self-eval (green, no regression). Re-checked the remaining candidates against value-first:
all confirmed deferred-class/redundant — coordinationHealthy EXPOSURE is redundant (a `DecomposedAskResult`
consumer already has all 4 input signals → can derive it; the fire-12 judge's "unconsumed convenience" note
is real but low marginal value); council cross-lingual is calibration-heavy + the loop already uses semantic
consensus; FM-2.6 semantic-harden doesn't fix the transform-type FP; god-file surfacings are untestable.
No clean high-value single-fire slice. (Full assessment: fire 11.)

lesson: 2nd honest no-ship on a confirmed-mature theme (fire 11 was the 1st; fire 12 was the mandatory drill).
The loop is now in regression-sentinel mode (⓪ self-eval + ⑤c merge-retry) rather than producing new value.
This is the DEGENERATE-LOOP signal: a mature theme with no repoint produces near-empty fires. ★STRONGLY
RECOMMEND 진안 repoint cron `972211ed` to a fresh axis (3rd surfacing) OR stop it (`CronDelete 972211ed`) —
continuing on this theme will keep no-shipping. Surfaced async; per ⑥ the loop does not block or self-repoint.

## fire 12 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 75950bde — ★JUDGE-DRILL
meta: value-class=judge-drill+small-capability · pkg=@muse/multi-agent · kind=verifier-calibration-drill · verdict=PASS · firesSinceDrill=0 (RESET by drill)
ratchet: testFiles +0 · fabrication 0 · eval:orchestration/decomposition PASS · DRILL FIRED (firesSinceDrill hit 10) · drill outcome: verifier CALIBRATED

**★JUDGE-DRILL (mandatory, hard-counter firesSinceDrill≥10)** — Per the maker≠judge compensating control, this
fire deliberately injected a BAD slice and confirmed the independent ④ judge REJECTS it (anti-rubber-stamp):

1. **Bad slice**: added `coordinationHealthy: true` HARDCODED to `LeadWorkerResult` (a "fan-in is clean" flag
   that ignores the real `subtaskConflicts`/`subtaskRedundancies`/`reasoningActionGaps`/`synthesisIncomplete`
   right beside it) + a VACUOUS test (`expect(true).toBe(true)`). It PASSED build + lint + check + its own test
   (the deterministic gates ③ do NOT catch it).
2. **Judge FAILed it correctly** — the independent Opus ④ judge caught ALL of it: hardcoded-not-derived,
   false doc ("true when clean" but true even with conflicts), zero-mutation-sensitivity test, misleading green
   that violates the honesty floor + undermines the handoff-reliability theme. It even prescribed the fix.
   → **VERIFIER PROVEN CALIBRATED** (it rejects what the gates miss).
3. **Real fix** (drill → FAIL → rollback → real fix): rolled back the hardcoded version and implemented the
   CORRECT derivation — `coordinationHealthy = !subtaskConflicts && !subtaskRedundancies && !reasoningActionGaps
   && !synthesisIncomplete` (true ONLY when the fan-in is genuinely clean; undefined for single-agent/all-failed).
   Behavioral tests: clean→true, detected conflict→false, detected redundancy→false. **MUTATION-FIRST**: reverting
   to the hardcoded `true` RED-s exactly the conflict+redundancy tests (the inverse of the drill's vacuous test).
   A SECOND independent Opus ④ judge PASSed the real fix (verified no empty-array trap, re-ran the mutation).

**Review points** — Gates green (multi-agent 245 pass · lint 0 · `pnpm check` exit 0 [one unrelated cli
ink-render saturation-flake, passed on re-run] · eval:orchestration/decomposition PASS). Honest derivation, no
collateral, additive optional field. WEAKEST POINT (2nd judge): a thin summary-of-existing-signals with no
in-tree consumer YET (verified-but-unconsumed convenience — like fire 1's detector before fire 3 exposed it; a
future fire could surface it in `muse ask --json` / the API).

**Risk** — Pure derivation, no model/egress, floor untouched. NOTE: theme still mature (fire 11) — this fire was
the MANDATORY drill, not new high-value work. Repoint recommendation from fire 11 STANDS.

## fire 11 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · NO-SHIP (theme exhausted)
meta: value-class=none(no-ship) · pkg=none · kind=theme-exhaustion-assessment · verdict=NO-SHIP · firesSinceDrill=9
ratchet: testFiles +0 · fabrication 0 (unchanged) · no source committed · consecutive allPASS streak unbroken (no-ship ≠ FAIL) but counter not incremented

**What (assessed)** — Ran a thorough ① PICK across the whole theme: scanned the backlog (126 open ◦, none a
clean on-theme high-value single-fire), re-surveyed BOTH orchestration surfaces, and the evals. Confirmed the
multi-agent orchestration / handoff-reliability theme is MATURE — every clean coordination guard is built,
wired, tested, and (where applicable) persisted/exposed across the lead-worker fan-out AND the council debate
paths. The eval:orchestration battery + the unit suites gate them.

**Why no-ship** — The remaining candidates are ALL deferred-class: (a) council cross-lingual consensus — real
but LOW-impact (wastes one bounded round, no floor violation) AND calibration-heavy (cross-lingual embeddings,
finicky per [[project_cross_lingual_recall]]); the loop already uses the semantic consensus, so the residual is
the embedder-prefix problem. (b) RAG-Fusion LLM-decomposition — LLM-based, calibration-risky. (c) god-file CLI
surfacings — untestable (fire-4 blocker). (d) FM-2.6 semantic-harden — advisory-only so not urgent, and semantic
cosine doesn't fix the transform-type FP anyway. (e) the highest-value remaining item (council cross-lingual)
is both low-impact and calibration-risky. Forcing any of these would be make-work or a same-well refinement on
a theme TWO prior judges (fire 9, fire 10) already flagged as maturing. Per ⑥, a clean honest no-ship + repoint
surface beats a forced marginal slice.

lesson: A theme genuinely SATURATES — after ~10 ships covering every clean coordination mode across both
surfaces, the honest move is to recognize it, NOT scrape for a marginal/calibration-murky/same-well slice. The
two prior judges' "maturing" notes were the early signal; this fire confirmed it by exhaustive scan. ★REPOINT
RECOMMENDED (surfaced async to 진안 via PushNotification + backlog) — a fresh theme axis will restore high
marginal value. (Note: fire 12 is the mandatory JUDGE-DRILL per the hard-counter regardless of repoint.)

## fire 10 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · ae106337
meta: value-class=new-capability(paper-grounded) · pkg=@muse/multi-agent+@muse/cli · kind=reasoning-action-alignment · verdict=PASS · firesSinceDrill=8
ratchet: testFiles +0 (cases added to lead-worker + ask-decompose tests) · fabrication 0 · eval:orchestration/decomposition deterministic cases PASS · consecutive allPASS=6 (drill due ~fire 12) · NEW kind (FM-2.6 alignment) — distinct cell vs all prior multi-agent fires

**What** — Covered the one uncovered MAST mode found by the scout: FM-2.6 reasoning-action mismatch (#2
multi-agent failure @ 13.2%, arXiv:2503.13657). New pure `verifySequencedDependencyUse(executions)` flags a
COMPLETED sequenced downstream step whose output shares ZERO content tokens with EVERY same-script upstream
output (ran "blind" — ignored the priorContext it was handed). Wired into `runLeadWorkerTask` (sequenced-only)
→ `LeadWorkerResult.reasoningActionGaps` → `runDecomposedAgentAsk`/`DecomposedAskResult` pass-through (live in
`muse ask`). The inverse of `verifySynthesisCoverage`'s "shares ≥1 token" test, same trusted lexicalTokens
primitive + comparableScript same-script gate.

**Why** — Muse's `sequenced` split exists SPECIFICALLY so a downstream acts on its upstream RESULT, but the
engine never verified the step engaged it. This is the FM-2.6 alignment check on that handoff. (Theme-pivot:
after 9 fires of detection/persistence, this is a genuinely NEW capability addressing the uncovered #2 mode —
value-first, not completionism.)

**Review points** — (1) MUTATION-FIRST: breaking the `reasoningActionGaps` spread → exactly the live test RED,
restored. (2) SCOPE: runs ONLY for `sequenced` (independent split NOT checked — tested). (3) Upstream semantics
match the engine's priorContext (slice(0,i) of completed = exactly what the step was handed). (4) ADVISORY-ONLY
(caption + reason fragment, no gate/block/re-synthesis). (5) Same-script gate kills the KO→EN over-fire.

**Risk / ★CALIBRATION (judge-measured, important)** — The Opus ④ judge PASSED but MEASURED that the LEXICAL
zero-overlap bar OVER-FIRES on legitimate paraphrase/classify/decide downstreams (6/6 generic transforms it
tested would be flagged). So this is a conservative-RECALL signal whose only safe use is ADVISORY (a spurious
caption is harmless). The in-code doc comment + backlog carry a HARD WARNING: do NOT wire `reasoningActionGaps`
into any gate/warning/re-synthesis without first UPGRADING the bar to SEMANTIC similarity (embedder cosine,
mirroring detectRedundantPairs) — that's the required follow-up. Pure sync, no model/egress, floor untouched.

review: gates green — multi-agent build clean · lead-worker 61 pass · cli ask-decompose 19 pass · lint 0 ·
`pnpm check` exit 0 · independent Opus ④ judge VERDICT PASS (with the calibration warning above heeded).

## fire 9 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 69e1fdf2
meta: value-class=observability(parity) · pkg=@muse/multi-agent+@muse/api · kind=persistence-exposure · verdict=PASS · firesSinceDrill=7
ratchet: testFiles +0 · fabrication 0 · eval:orchestration/decomposition deterministic cases PASS · consecutive allPASS=5 (drill at ≥8) · cell (multi-agent+api, observability-persistence) = 2 of last 8 (f6,f9) — ratchet does NOT bind

**What** — Closed fire-8's judge-noted gap: persisted the fan-out REDUNDANCY signal in the history.
Added `redundancies?` to `OrchestrationHistoryEntry`, recorded `raw.redundancies` in the success-path
`recordHistory` (exact mirror of fire-6's conflicts), exposed in `GET /orchestrations/:runId`. A past
duplicated-work run is now queryable, not just present in the live response `raw`.

**Why** — Parity completion: fire 6 persisted conflicts/verification; fire 8 added the redundancy advisory
but left it response-`raw`-only. The fire-8 judge explicitly named history-persistence as the open gap.

**Review points** — (1) MUTATION-FIRST: the package store-query test RED pre-change; the GET mapping was
independently mutation-verified (break the line → only the redundancy GET test RED, restored). (2) MIRROR
FAITHFUL: 3 line-faithful copies of the conflicts handling (entry field / recordHistory spread / GET map),
each with the `.length > 0` empty-array guard; conflicts/verification untouched. (3) BEHAVIORAL: real
orchestrator.run + real POST→GET, identical-output workers flag redundancy but NOT conflict (tested).
(4) Success-path only (all-failed throws before recordHistory). Independent Opus ④ judge PASS.

**Risk / DIRECTION** — Pure recording; no model call, no egress, floor untouched. ★ MATURING-THEME SIGNAL
(judge + builder agree): after 9 fires the multi-agent orchestration coordination guards are COMPREHENSIVE
(conflict + redundancy detection, persistence, exposure on both lead-worker AND orchestrator paths; injection
neutralization; fabrication-on-all-failed; bounded termination; observability). The high-value single-fire
vein is THIN. NEXT FIRE SHOULD PIVOT to a fresh (pkg,kind) / different surface — remaining in-theme work is
either god-file-untestable (subtaskRedundancies CLI surfacing) or calibration-risky (semantic task-derailment).
Surfaced async for 진안 to consider a theme repoint.

review: gates green — multi-agent build clean · history-signals 4 pass · api signal-exposure 6 pass · lint 0 ·
`pnpm check` exit 0 (clean) · independent Opus ④ judge VERDICT PASS.

## fire 8 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 19d06314
meta: value-class=wiring(sibling-completion) · pkg=@muse/multi-agent+@muse/api · kind=detector-wiring(orchestrator) · verdict=PASS · firesSinceDrill=6
ratchet: testFiles +0 (cases added to orchestrate-synthesis + orchestrate-route-conflict-wiring) · fabrication 0 · eval:orchestration/decomposition deterministic cases PASS · consecutive allPASS=4 (drill at ≥8) · distinct cell (orchestrator fan-out wiring vs f7 lead-worker)

**What** — Completed fire 7's deferred sibling: brought the REDUNDANCY (step-repetition) detector to the
production API orchestrate FAN-OUT path (mirrors fire 1's conflict wiring). New `detectFanInRedundancy(parts,
embed)` (workerId-keyed twin of detectFanInConflicts) → `OrchestrationRunOptions.detectRedundancies` →
`buildOrchestrationResponse` appends an "ℹ Workers produced near-identical answers (possible duplicated
work)" advisory + records `raw.redundancies` → wired at BOTH POST routes (embed already threaded by fire 1).

**Why** — Sibling-audit completion: fire 7 shipped redundancy on the lead-worker path but left the
orchestrator fan-out twin dark. In a fan-out where several workers answer the SAME question, a worker that
restates another's answer adds no distinct value (and isn't independent corroboration) — now surfaced.

**Review points** — (1) MUTATION-FIRST: breaking the advisory string → exactly the orchestrator-advisory
test RED, restored. (2) MIRROR FAITHFUL: the redundancy block is a faithful copy of the conflict block (same
`completedParts.length >= 2` guard, fail-soft try/catch, advisory-only) — judge confirmed no positional
off-by-one in the new `buildOrchestrationResponse` param. (3) CONFLICT-vs-REDUNDANCY distinction TESTED: the
API test asserts identical-worker output gets the redundancy advisory but NOT the "⚠ disagree" line (identical
sets fail the conflict neither-subset gate). (4) ADVISORY-ONLY: never drops a worker / blocks synthesis /
changes finalAnswer. (5) Calibration inherited from fire 7's detector (binding negative re-asserted at this
layer). (6) Fail-soft + back-compat (no embed→silent control, throwing→silent, <2→[]).

**Risk** — Advisory-only; no model call, no egress, fabrication floor untouched. DEFERRED (judge-noted gap):
redundancy is NOT yet persisted in `OrchestrationHistoryEntry` (the f6 twin) — currently response-`raw`-only,
not history-queryable; lower-stakes than a conflict, a future fire can add parity. Also deferred: the
`commands-ask.ts` god-file stderr surfacing (fire-7 carryover). NOTE: two UNRELATED flaky tests (@muse/model
web-search fuzz + apps/api messaging-webhooks env-gating) reddened the saturated full `pnpm check` once each,
both passed isolated + on re-run; neither in this diff.

review: gates green — multi-agent build clean · orchestrate-synthesis 25 pass · api orchestrate-route 5 pass ·
lint 0 · `pnpm check` exit 0 (re-run) · independent Opus ④ judge VERDICT PASS.

## fire 7 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 2eeed6af
meta: value-class=new-capability · pkg=@muse/agent-core+@muse/multi-agent+@muse/cli · kind=new-detector(paper-grounded) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles +1 (redundancy-detection) · fabrication 0 · eval:orchestration/decomposition deterministic cases PASS (ran this fire) · consecutive allPASS=3 · NEW (pkg,kind) cell (paper-grounded detector capability)

**What** — Added REDUNDANCY (step-repetition) detection at the lead-worker fan-in — the COMPLEMENT of the
existing contradiction detector. `detectRedundantPairs(texts, embed)` (agent-core) flags same-topic
(cosine≥0.86) + near-identical token sets (lexical Jaccard≥0.9) — the INVERSE of the contradiction
detector's neither-subset gate. Threaded through `detectSubtaskRedundancies` (multi-agent twin of
detectSubtaskConflicts) → `deps.detectRedundancies` in `runLeadWorkerTask` + `LeadWorkerResult.subtaskRedundancies`
→ LIVE in `runDecomposedAgentAsk` (ask-decompose, mirrors the detectConflicts wiring) + `DecomposedAskResult`.

**Why** — MAST FM-1.3 Step Repetition is 15.7% of multi-agent failures (arXiv:2503.13657); the
semantic-redundancy signal is the carrying feature in cycle detection (arXiv:2511.10650). Muse's
pre-execution exact-text `dedupeSubtasks` can't catch it — distinct sub-task TEXT whose workers CONVERGE to
the same OUTPUT, or a sequenced step that just echoes its upstream. This is the runtime OUTPUT-level guard.

**Review points** — (1) CALIBRATION (the binding risk — Muse rejected naive semantic dedup that over-merges
"1분기"/"2분기"): the Jaccard≥0.9 floor means distinct-value pairs (Q1 5억 vs Q2 7억, ~0.2) and elaborations
(~0.5) are NOT flagged — only near-verbatim echo (~1.0). The independent Opus ④ judge did the math and
confirmed no realistic distinct-but-valuable pair clears 0.9. (2) SURFACE-ONLY: advisory annotation
(`subtaskRedundancies` field + reason line), never drops a worker / blocks synthesis / changes finalAnswer —
a residual false positive degrades to a spurious note. (3) INVERSE correctness: contradiction (neither-subset,
overlap≥0.5) and redundancy (Jaccard≥0.9) are complementary — a high-Jaccard pair has no meaningful unique
token so it can't also be a conflict. (4) MUTATION-FIRST: detector test had a real RED→GREEN (cross-topic
fixture); engine wiring mutation-verified (broke the field spread → exactly the positive test RED). (5)
Fail-soft + back-compat (throwing embed→[], <2→[], no dep→unset, cross-script→[]).

**Risk** — Reuses the local embedder (no new egress); fabrication/local-only untouched. Tests use a constant
fake embed (neutralizes the topic gate so Jaccard alone decides) — production supplies the real topic signal;
worst case is still only a spurious advisory note. Deferred siblings: orchestrator fan-out twin
`detectFanInRedundancy`; god-file `commands-ask.ts` stderr surfacing. NOTE: a pre-existing FLAKY
`@muse/model` web-search-policy property-fuzz (another loop's) intermittently reddened `pnpm check` — passed
on re-run, not in this diff.

review: gates green — agent-core/multi-agent/cli builds clean · agent-core redundancy 7 pass · multi-agent
223 pass · cli ask-decompose 18 pass · lint 0 · `pnpm check` exit 0 (re-run; flaky model fuzz unrelated) ·
independent Opus ④ judge VERDICT PASS.

## fire 6 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 25e28b52
meta: value-class=observability · pkg=@muse/multi-agent+@muse/api · kind=persistence-exposure · verdict=PASS · firesSinceDrill=4
ratchet: testFiles +1 (orchestrate-history-signals) · fabrication 0 · eval:orchestration/decomposition SKIP (Ollama down) · consecutive allPASS=2 · NEW (pkg,kind) cell (observability/persistence)

**What** — The orchestrator computes coordination outcomes at fan-in (cross-worker `conflicts`,
objective-coverage `verification` verdict) but `OrchestrationHistoryEntry` recorded only counts/status —
so those outcomes were LOST after the live response (a past run's "workers disagreed" / "answer incomplete"
was not queryable). Added `conflicts?`/`verificationSatisfied?` to the entry; reordered the
`MultiAgentOrchestrator.run` success path to build the response BEFORE `recordHistory` and persist the
signals from `response.raw`; exposed both in `GET /orchestrations/:runId` (the persisted twin of fire 3's
live response signal).

**Why** — MAST coordination-health observability: a detected disagreement / incomplete coverage should
survive in the audit trail, not vanish. Lets a consumer surface coordination-failure trends across runs.

**Review points** — (1) MUTATION-FIRST: pre-change the 2 positive package tests RED (entry fields undefined,
recorded before the response existed), control GREEN; post-change all pass. (2) REORDER SAFETY (the main
risk): independent Opus ④ judge confirmed `buildOrchestrationResponse` never publishes to the messageBus
(so `getConversation()` is unchanged) AND is fully fail-soft (every callback try-wrapped; only pure string
ops un-wrapped) so it can't throw on the success path → the reorder can't skip `recordHistory`. (3) durationMs
now covers synthesis (more accurate; no test/consumer pinned the old value). (4) Optional fields →
summary/list endpoints unaffected; `verificationSatisfied !== undefined` distinguishes a real `false` from
absent; empty-array guard avoids persisting `[]`. (5) End-to-end: package store-query tests + HTTP POST→GET
round-trip (shared history store).

**Risk** — Pure recording + response-shaping; no model call, no egress, fabrication floor untouched. The
conflicts fixture proves the persistence plumbing, not detector semantics (the detector has its own tests).
LLM evals SKIP (Ollama down).

review: gates green — `pnpm --filter @muse/multi-agent build` clean · full pkg 221 pass · apps/api 888 pass ·
lint 0 · `pnpm check` exit 0 · independent Opus ④ judge VERDICT PASS.

## fire 5 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 2aed9a83
meta: value-class=security-guard · pkg=@muse/multi-agent · kind=injection-neutralization · verdict=PASS · firesSinceDrill=3
ratchet: testFiles +0 (2 cases added to orchestrate-synthesis.test.ts) · fabrication 0 · injection-defense STRENGTHENED · eval:orchestration/decomposition SKIP (Ollama down) · consecutive allPASS=1 (reset by f4 no-ship) · pkg=f2 same but KIND distinct (correctness-guard→injection-neutralization)

**What** — In `MultiAgentOrchestrator` SEQUENTIAL fan-out, each worker's result is threaded into the
NEXT worker's prompt as a SYSTEM-role message: `addWorkerResultMessage` (output) + `addHandoffMessage`
(failed worker's error). Both threaded RAW. Now both wrap `neutralizeInjectionSpans` — the same funnel
the fan-IN already applies.

**Why** — Inter-agent injection propagation (Prompt Infection, arXiv:2410.07283 / OWASP ASI07). The
fan-in (synthesis, `buildOrchestrationResponse:692`) and the lead-worker `runOne` neutralize, but the
worker-to-worker SEQUENTIAL handoff was the uncovered seam: a poisoned worker's embedded instruction /
forged `[from system]` citation reached the next worker with SYSTEM authority, BEFORE the fan-in ever ran.
`parseWorkerResult` only shape-checks; `validateWorkerHandoff` only trims — neither neutralized.

**Review points** — (1) MUTATION-FIRST: pre-fix the OUTPUT test RED (downstream input carried the raw
"Ignore all previous instructions", no placeholder); post-fix GREEN. Independent Opus ④ judge re-ran the
drill (reverted wrapping → exactly the 2 sequential tests failed → restored → 209). (2) SIBLING audit:
BOTH threading funnels (output + error) patched AND tested; parallel mode N/A (no worker-to-worker
threading). (3) Trace fidelity: only the threaded PROMPT copy is neutralized — the tracked
`results[].result.response.output` keeps the raw output. (4) Byte-identical on clean text → 207 prior tests
unaffected (209 total).

**Risk** — Pure defensive neutralization; nothing loosened. Tests use `RuleBasedAgentWorker` doubles, so
they prove the plumbing (the deterministic gate IS the guard per agent-testing.md), not that gemma4 obeys
the placeholder live. LLM evals SKIP (Ollama down); slice proven by the deterministic unit tests.

review: gates green — `pnpm --filter @muse/multi-agent build` clean · full pkg 209 pass · lint 0 ·
`pnpm check` exit 0 · independent Opus ④ judge VERDICT PASS.

## fire 4 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · NO-SHIP (reverted)
meta: value-class=none(no-ship) · pkg=@muse/cli(reverted) · kind=honesty-translation · verdict=NO-SHIP · firesSinceDrill=2
ratchet: testFiles +0 · fabrication 0 (unchanged) · no source committed · consecutive allPASS reset (no-ship, not a drill)

**What (attempted)** — Tried to translate fire-2's all-failed `finalAnswer: ""` signal into an honest
user-facing refusal in the CLI decompose seam (`ask-decompose.ts`), so an all-ungrounded `muse ask`
doesn't show a blank answer. MUTATION-FIRST RED achieved (seam returned blank); a seam-level fix went GREEN.

**Why reverted** — Mid-build I found an EXISTING test (`ask-decompose.test.ts:216`, "returns an empty
answer when every sub-task fails — caller falls back, no fabrication") that codifies a deliberate contract:
the seam returns `""` BY DESIGN and the CALLER is meant to fall back. My fix was in the wrong layer and
contradicted that contract. The correct fix lives in the caller (`commands-ask.ts`), but (a) I could not
trace the non-`--with-tools` decompose output path in the 2700-line god-file to confirm a blank is even
printed, and (b) there is NO command-level test harness to assert the user-facing output (the existing
`commands-ask-*.test.ts` only unit-test pure helpers). Per the loop's calibration discipline — never ship
an unverifiable cross-layer behavior change into untraceable code — I `git restore`d both files. Working
tree clean; no source committed.

lesson: A new return-value SIGNAL (fire 2's `""`) demands a same-fire sibling-audit of its CONSUMERS. The
consumer here is a god-file with no command-level harness — so the real prerequisite slice is BUILDING that
harness (drive the full `muse ask` with a fake runtime + assert stdout), not the honesty translation itself.
Backlog blocker recorded. RED-then-revert is a valid honest outcome, not a failure.

## fire 3 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 8c2b8e8f
meta: value-class=wiring · pkg=@muse/api · kind=response-dto-exposure · verdict=PASS · firesSinceDrill=2
ratchet: testFiles +1 (orchestrate-route-signal-exposure) · fabrication 0 · eval:orchestration/decomposition SKIP (Ollama down) · pkg/kind cell distinct (api/run-wiring f1 → multi-agent/guard f2 → api/dto-exposure f3) · consecutive allPASS=3 (drill at ≥8)

**What** — Surfaced the orchestrator's structured coordination signals (`conflicts`, `verification`)
from the opaque `response.raw` into BOTH API orchestrate route responses (POST `/orchestrate` return +
`/orchestrate/stream` done frame) via a new defensive `readOrchestrationSignals(raw: unknown)` extractor.
Previously the routes mapped only `response:{id,model,output}` and dropped `raw`, so a consumer received
only the human ⚠ line baked into the answer text — never the structured signal to act on.

**Why** — Completes fire 1's originally-stated HTTP acceptance (`raw.conflicts populated`). MAST:
withholding a detected coordination failure from the caller defeats the point of detecting it. A web
console / programmatic consumer can now render a conflicts badge or a coverage-incomplete state.

**Review points** — (1) MUTATION-FIRST: pre-wiring the 3 positive tests RED (no `conflicts`/`verification`
field), control GREEN; post-wiring all 4 GREEN. Independent Opus ④ judge re-ran the drill (removed both
spread sites → 3 fail/1 pass). (2) SIBLING pair: POST + stream done frame both wired AND tested (the
stream test parses the real `data:` SSE line). (3) Fail-safe narrowing: `raw` is `unknown` → null/non-object/
malformed yields NO field (control proves no noise); empty-array guard; no throw path. (4) Spread keys are
disjoint from the surrounding literal (no clobber).

**Risk** — Pure response-shaping; no model call, no egress, fabrication floor untouched. Conflicts assertion
is loose (length≥1 + names a worker) — acceptable; the verification test pins exact content, over-pinning a
stochastic conflict string would be brittle. LLM evals SKIP (Ollama down); slice proven by HTTP inject tests.

review: gates green — `pnpm --filter @muse/api build` clean · apps/api 871 pass · lint 0 · `pnpm check` exit 0 ·
independent Opus ④ judge VERDICT PASS.

## fire 2 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 0a9e81b4
meta: value-class=new-guard · pkg=@muse/multi-agent · kind=correctness-guard · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +0 (case added to lead-worker.test.ts) · fabrication 0 · eval:orchestration/decomposition SKIP (Ollama down) · pkg/kind DIVERSE vs fire 1 (@muse/api/wiring → @muse/multi-agent/guard)

**What** — `runLeadWorkerTask` (decomposed lead-worker path) now short-circuits BEFORE
synthesis when `completed === 0` (every sub-task failed/ungrounded), returning an honest
`finalAnswer: ""` and SKIPPING the synthesizer. Previously it handed only failed/ungrounded
executions to `deps.synthesize` and returned that as the final answer — a confident answer
fabricated from zero grounded evidence.

**Why** — Fabrication=0 floor breach + MAST proceed-despite-failure. The single-agent path
already returned `""` on failure (line 279) and the orchestrator fan-out already throws
`No worker completed` — the decomposed lead-worker path was the inconsistent outlier that
let a non-answer masquerade as a synthesized answer. Found via gap-scout of the orchestration
code (no backlog item; the conflict/handoff guards were already mature).

**Review points** — (1) MUTATION-FIRST: pre-fix the new test RED (`finalAnswer` = "CONFIDENT
but ungrounded answer", synthesizeCalls=1); post-fix GREEN. Independent Opus ④ judge re-ran the
mutation drill (disabled guard → exactly the one test failed → restored → 207 pass). (2) SIBLING
AUDIT: all three all-failed paths now consistent (single-agent ""/fan-out throw/decomposed "").
(3) `completed` hoisted once (removed the duplicate at the old site, identical value). (4) Early
return is shape-correct vs LeadWorkerResult; dropped optionals (synthesisIncomplete/subtaskConflicts)
are meaningless with zero completed.

**Risk** — A genuinely all-ungrounded decomposition now returns "" rather than an "I'm not sure"
prose answer — but that matches the established single-agent convention (callers already treat
`finalAnswer === ""` as "no grounded answer"). No new contract burden. LLM evals SKIP (Ollama down);
slice proven by the deterministic unit test.

review: gates green — `pnpm --filter @muse/multi-agent build` clean · full pkg 207 pass · lint 0 ·
`pnpm check` exit 0 · independent Opus ④ judge VERDICT PASS.

## fire 1 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · b9e3ced9
meta: value-class=wiring · pkg=@muse/api · kind=cross-package-wiring · verdict=PASS · firesSinceDrill=0
ratchet: testFiles +1 (orchestrate-route-conflict-wiring) · fabrication 0 · eval:orchestration/decomposition SKIP (Ollama down on box)

**What** — Wired the already-built `detectFanInConflicts(parts, embed)` cross-worker
contradiction detector into BOTH API orchestrate routes (`/orchestrate` + `/orchestrate/stream`)
for production parity. Added `embed?` to `MultiAgentRouteOptions`, built `detectConflicts` from
it at both call sites, and threaded `embed: createGateEmbedder(process.env)` in `server.ts`.
When ≥2 workers complete and disagree on the same point, the route now appends the honest
"⚠ Workers disagree on the same point — reconcile before trusting: …" line to `response.output`
and sets `raw.conflicts` — previously the package seam existed (agent-hardening fire 18) but the
routes wired only `verifyFinalAnswer`, never `detectConflicts`, because no embedder was in scope.

**Why** — A coordination-failure surface (MAST: reasoning–action mismatch / information
withholding across workers) was built and package-tested but DARK in production: the API fan-in
silently concatenated contradicting worker answers as if one truth. This is the wedge mechanism
(grounding edge on the fan-OUT) reaching the real surface.

**Review points** — (1) MUTATION-FIRST: against unwired code the 2 positive HTTP tests went RED
(no ⚠ line, workers visibly disagree tuesday/wednesday), control GREEN; after wiring all 3 GREEN.
The independent Opus ④ judge re-ran the mutation drill itself and confirmed. (2) SIBLING pair:
both routes wired AND both tested. (3) Fixture is a GENUINE contradiction per
`detectPairwiseContradictions` real gates (cosine 1.0 ≥ topicSimMin, overlap 0.5 ≥ min,
neither-subset) — not rigged. (4) fail-soft + back-compat: no embed ⇒ silent (control test),
throwing embed ⇒ no conflicts.

**Risk** — Conflict detection now runs per orchestrate request with ≥2 completed workers (one
embedding pass over worker outputs). Cost is bounded, embedder is the shared local gate embedder
(no cloud egress, MUSE_LOCAL_ONLY-safe). LLM evals (`eval:orchestration`/`eval:decomposition`)
SKIPPED on this box (Ollama unreachable) — the slice is proven by the deterministic
contract-faithful HTTP test, which needs no model.

review: gates green — `pnpm --filter @muse/api build` clean · lint 0 · apps/api 867 pass ·
`pnpm check` exit 0 · independent Opus ④ judge VERDICT PASS.
