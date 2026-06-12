# Tool-selection measured-improvement scoreboard

The trend anchor for the tool-selection loop (plan:
`docs/superpowers/plans/2026-06-12-tool-selection-measured-improvement-loop.md`).
Each fire appends: date · `eval:tools` pass^k score · failing cases · the change.

| date | k | eval:tools | failing cases | change / note |
|------|---|------------|---------------|---------------|
| 2026-06-12 | 1 | **134/134 (100%)** | none | **Fire 1 baseline.** Single-run accuracy SATURATED (threshold 85%). |
| 2026-06-12 | 3 | **18/18 at 3/3 then stopped** | none | pass^k partial: first 18 cases all 3/3, 0 fail — reliability also clean. Stopped early (Ollama needed for the next lever); k=1 100% + 18/18 3/3 = eval:tools EXHAUSTED. |
| 2026-06-12 | — | grounding: **faithfulness 1.00, false-refusal 0.00** | none | Fallback lever (grounding false-refusal recall) measured via `doctor --grounding` (29 cases: 12 answerable / 8 refuse / 9 drift) on fresh build — 17/17 unfaithful caught, 0/12 wrongly refused. ALSO SATURATED. |

## Fire 2 finding (decisive): BOTH levers saturated on the bundled corpora

`eval:tools` = 100% (k=1) / 18-18 3-of-3 (k=3 partial), and grounding =
faithfulness 1.00 / false-refusal 0.00. The primary lever AND the first fallback
have ZERO headroom on the existing golden/bundled sets. The remaining doctrine
levers (eval:vision, eval:plan-quality) are golden-corpus-scored too and will
almost certainly hit the same ceiling.

**Why:** the bundled corpora are small, curated, and the 12B already one-shots
them. Per agent-testing.md the only legitimate way to expose real headroom is
HARDER cases drawn from REAL usage misses — and per the improve-muse memory the
error-analysis / real-trace outcome-logging fuel that would supply those is not
wired yet. Manufacturing fake-fail golden cases to create headroom would violate
decision 4 (no gaming) and agent-testing.md ("from real misses, not imagination").

**Principled pivot (decide-and-do, not defer):** the loop's highest-value move is
no longer "nudge a saturated number" but **probe the assembled agent for a GENUINE
failure** (compound/multi-step intent, partial-grounding, code-switching, vague
imperative) via real `muse ask` / the agent path; a real miss becomes a golden
case + a fix (true measured headroom). If sustained probing finds no real miss,
the honest conclusion is the agent is at ceiling on what we can currently measure,
and the next real lever is building real-trace failure fuel (infra) — a direction
call for Jinan. Recorded here so the loop doesn't burn fires gaming saturated sets.

## Key finding (Fire 1)

`eval:tools` at k=1 is already 100% (134/134). The golden set covers EN+KO across
time-tools, file-read, browser-control, personal-crud, recall-vs-crud confusable
sets and no-tool/IrrelAcc traps — all pass on gemma4:12b in one shot. So the
"move the accuracy number" headroom on THIS set is zero; the only remaining
tool-selection headroom is **pass^k reliability** (does every case pass on ALL k
repeats?). If k=3 is also clean, the principled move (plan decision 6) is to
switch the primary lever to **grounding false-refusal recall** (documented 0.08
baseline = real headroom, core edge, high user value), verified with real
`muse ask` on grounded questions — not to manufacture harder golden cases without
real-usage failures to draw from.

| 2026-06-12 | — | eval:vision: **4/4 PASS** | none | Third lever (grounded-vision routing: receipt/flyer/card/doc → note/calendar/contact) also SATURATED on gemma4:12b. |

## Fire 3 — ALL THREE measurable levers saturated; doctrine chain exhausted

eval:tools 100% · grounding 1.00/0.00 · eval:vision 4/4. Two real assembled-agent
probes (ungrounded personal recall; compound "show schedule AND tasks") surfaced
no INDISPUTABLE failure — honest refusal held, and the compound case gave a
reasonable conversational offer (not a clear tool-selection miss). The whole
doctrine lever chain (tools → grounding → vision → plan-quality) is at ceiling on
bundled corpora, and casual probing isn't yielding clear misses either.

**Decisive conclusion:** measured-improvement on EXISTING corpora has no headroom.
The real unlock is SYSTEMATIC real-usage failure fuel (run-outcome logging →
error-analysis), the improve-muse-deferred infra — building it is a loop-objective
change. Surfaced to Jinan as a premise fork rather than spinning fires on
saturated metrics.

## 2026-06-12 PIVOT (Jinan's decision) — loop objective → real-usage failure-fuel pipeline

All three measurable levers saturated (above). Jinan chose: build the real-usage
failure-fuel pipeline so future measurement regains headroom (improve-muse's
deferred unlock). Loop upgraded v3→v4 (cron 32b23ef1).

Explored infra (don't rebuild): weakness-ledger.ts (SINK), writeRunLog (run-log
+ outcome label), askOutcomeLabel. GAP: only chat-repl feeds recordWeakness —
the ASK path's ungrounded/abstain outcomes are run-logged but never mined into
the ledger, and no analyzer turns run-logs into weakness patterns.

v4 backlog: (1) wire ask-path `ungrounded` → grounding-gap weakness (mirror
chat-repl); (2) run-log → weakness analyzer surfaced in `muse doctor`; (3) the
error-analysis report ranking remediable weaknesses. Each verified by a REAL
`muse ask` that then shows a weakness entry in the ledger.

## v4 Fire 1 — ask-path outcome → weakness ledger (SLICE SHIPPED)

The ASK path now feeds the weakness ledger: `askWeaknessAxis` maps abstain /
ungrounded → `grounding-gap`, and `recordAskWeakness` (best-effort, lazy-import)
records it with the query. Wired at the run-log point in commands-ask.ts.
Previously only chat-repl fed the ledger, so one-shot ask misses were invisible
fuel. Unit: 5 cases (axis mapping + record/no-record/empty/throws). REAL muse:
`MUSE_WEAKNESSES_FILE=/tmp/… ask "내 여동생 생일이 언제지?"` → honest abstain AND a
`grounding-gap` ledger entry {topic:"여동생 생일 언제지", count:1} appeared. First
real-usage fuel now flows; next slices mine .muse/runs run-logs + rank
remediable weaknesses.

## v4 Fire 2 — run-log failure-RATE analyzer + `muse doctor --run-outcomes` (SLICE SHIPPED)

The cumulative ledger counts failures but not the DENOMINATOR. Added
`analyzeRunOutcomes` (pure, @muse/mcp): tallies run-log outcomes (grounded/
abstain/ungrounded) into a fail-RATE + top failing topics (clustered via
topicKeyFromMessage). Surfaced via `muse doctor --run-outcomes` (reads
.muse/runs/*.jsonl). Unit: 4 analyzer + 2 formatter cases. REAL muse: 2 asks
(1 ungrounded→abstain, 1 grounded) → `doctor --run-outcomes` = "fail-rate 50%
(1 grounded · 1 abstain · 0 ungrounded), top: 여동생 생일 언제지". The fail-RATE
is a real metric with headroom (moves with real usage), unlike the saturated
golden sets — the measurement the loop needs to tell "improving" from "more use".

## v4 Fire 3 — dev-fixable weakness selector + doctor surface (SLICE SHIPPED)

selectRemediableWeaknesses gives the USER-fixable gaps (grounding-gap → "add a
note", surfaced in recap). Added its DEV-side mirror `selectDevFixableWeaknesses`
(@muse/mcp): the recurring weaknesses that are MUSE'S OWN bug (unbacked-action /
wrong-tool / time-parse), count≥2, most-recurring first — the dev loop's fix
targets. Surfaced via `muse doctor --weaknesses` (new 🔧 "Recurring agent bugs"
section, separate from the user gaps). Unit: 2 selector + 2 formatter cases.
REAL muse: seeded ledger (1 unbacked-action + 1 grounding-gap) → real
`doctor --weaknesses` lists both cumulatively AND shows ONLY the unbacked-action
under 🔧 dev-fixable. Closes the error-analysis loop: fuel → ledger → split into
user-remediable (recap) vs dev-fixable (the loop's targets).
