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
