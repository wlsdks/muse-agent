# PA-Tool style tool-name calibration — design spec

- **Date:** 2026-05-26
- **Status:** approved (brainstorming) — pending spec review
- **Direction:** research-based agent-quality upgrade (EXPANSION-PLAYBOOK priority #3)
- **Source idea:** PA-Tool — *Don't Adapt Small Language Models for Tools; Adapt Tool Schemas to the Models* (arXiv 2510.07248)

## Problem

`tool-calling.md` is Muse's first-class concern: the local Qwen (qwen3:8b,
reasoning=false) must pick the **right tool in ONE shot**. PA-Tool shows that
sub-10B models hallucinate "plausible-but-nonexistent" tool names — names that
match conventions seen in pretraining but absent from the provided schema
(schema misalignment). The training-free fix is to align tool component names
toward what the model already expects (measured by pretraining "peakedness").

Muse has felt this directly: `time_now` collided with `next_weekday`
(commit `ffbcb045`) and required a rename to `next_weekday_date` (`f0f5877b`)
to break the collision. Those renames were hand-guessed. There is no repeatable,
evidence-based way to discover the name the local model actually expects, nor to
prove a rename improves one-shot selection before shipping it.

## Goal

A **reusable calibration tool** that, for a confusable set of tools, discovers
the name the local model spontaneously expects and recommends a rename **only
when it measurably improves one-shot selection** — validated by the same
selection-rate signal `eval:tools` already trusts.

The calibration script itself is **dev infrastructure** (a quality gate, like
`eval:tools`). The user-facing outcome is the applied rename's reliability lift:
better names → Qwen picks the right tool in one shot → higher daily reliability.

## Non-goals (YAGNI)

- **No** blanket calibration of all ~35 built-in tools — only the one observed
  confusable set (the time tools) in this slice.
- **No** `aliases` field on `MuseToolDefinition` — this slice aligns the
  *canonical* name; a multi-name alias mechanism is a separate future slice.
- **No** refactor of `eval-tool-selection.mjs` to share a selection helper —
  the calibration script carries its own minimal selection call to stay
  contained; shared extraction is a follow-up.
- **No** automatic code mutation — calibration only reports; the rename is a
  human-applied edit (fail-safe).

## Architecture

Split along the codebase's existing seam (pure logic in a package; the
model-touching entry point in an Ollama-gated script).

### (a) Pure, deterministic core — `packages/tools/src/tool-name-calibration.ts`

Model-free, fully unit-testable. Exports:

- `normalizeToolName(raw: string): string`
  Lowercase, trim, collapse to `snake_case`, strip surrounding quotes/backticks
  and trailing punctuation, drop anything that is not a plausible
  `verb_noun`-style identifier (`^[a-z][a-z0-9_]*$` after normalization).
  Returns `""` for unusable input.

- `tallyPeakedness(samples: readonly string[]): { name: string; count: number; share: number }[]`
  Normalize each sample, drop empties, tally frequency, sort by count desc.
  `share = count / totalValidSamples`. Empty/all-invalid input ⇒ `[]`.

- `recommendRename(input: RenameDecisionInput): RenameDecision`
  ```ts
  interface RenameCandidate {
    name: string;          // normalized candidate
    rate: number;          // 0..1 one-shot selection rate for this tool with this name
    siblingRegression: boolean; // a sibling's selection regressed under this name
    collidesWithSibling: boolean; // candidate equals an existing sibling tool name
  }
  interface RenameDecisionInput {
    current: string;
    baselineRate: number;  // selection rate with the current name
    candidates: readonly RenameCandidate[];
    margin: number;        // required absolute lift over baseline (default 0.10)
  }
  interface RenameDecision {
    recommend: boolean;
    from: string;
    to?: string;
    reason: string;        // human-readable justification
  }
  ```
  Decision rule — recommend `from → to` iff there exists a candidate where ALL
  hold: `rate >= baselineRate + margin`, `!siblingRegression`,
  `!collidesWithSibling`, and `name !== current`. Among qualifying candidates,
  pick the highest `rate` (tie-break: highest discovery `share`, supplied via
  candidate order). Otherwise `recommend: false` with a reason
  (`"no candidate beats baseline by margin"`, `"all candidates regress siblings"`,
  `"name collision with sibling"`, `"no valid candidate discovered"`,
  `"current name already model-peaked"`).

- `formatCalibrationReport(results: CalibrationResult[]): { text: string; json: CalibrationResult[] }`
  `CalibrationResult` carries the per-tool peakedness distribution, baseline vs
  candidate rates, and the `RenameDecision`.

Unit test: `packages/tools/test/tool-name-calibration.test.ts`.

### (b) Model-touching script — `scripts/calibrate-tool-names.mjs`

`pnpm calibrate:tools`. Mirrors `eval-tool-selection.mjs`:
- imports `OllamaProvider` from `packages/model/dist`,
- `LOCAL OLLAMA ONLY`; if Ollama is unreachable → print skip notice, **exit 0**,
- `MUSE_EVAL_MODEL` (default `qwen3:8b`), `OLLAMA_BASE_URL`,
- new envs: `MUSE_CALIBRATE_PROBE_SAMPLES` (default 12),
  `MUSE_CALIBRATE_REPEAT` (default 5, selection runs per name-set),
  `MUSE_CALIBRATE_MARGIN` (default 0.10), `--json` flag.

It wires the pure core to two live operations (below).

## Data flow

```
calibrate:tools  (Ollama-gated)
 └ for each tool-under-test T in the confusable set
   (1st application: time_now / time_diff / next_weekday_date):
    [1] generative naming probe:
         prompt Qwen (temp ~0.7, NO schema) ×N:
           "Name a single tool/function (snake_case verb_noun) that does this
            job: <T.job>. Reply with ONLY the name."
         → collect N raw outputs → tallyPeakedness() → top-K distinct candidates
            (the names the model spontaneously produces most = peakedness proxy)
    [2] selection-rate validation:
         for nameSet in { baseline=current names, ...each candidate swapped for T
                          (siblings held at canonical) }:
           expose T + siblings to Qwen over T's golden prompts (temp 0, ×repeat)
           → one-shot selection rate for T's prompts
           → siblingRegression = any sibling prompt mis-selects vs baseline
    [3] recommendRename({ current, baselineRate, candidates, margin })
 └ formatCalibrationReport(results) → stdout (human) / --json
```

**Golden prompt source.** The first confusable set reuses the time-tool prompts
that already exist in `eval-tool-selection.mjs`'s real-tools scenario, so no
duplicate golden data is introduced. The job descriptions for the probe come
from each tool's own `definition.description`.

## Error handling

- Ollama unreachable → skip, exit 0 (parity with `eval:tools`).
- Probe returns empty/garbage → `normalizeToolName` drops it; if zero valid
  candidates → `recommend: false` (`"no valid candidate discovered"`).
- Candidate equals an existing sibling name → `collidesWithSibling: true` →
  the candidate is rejected (never recommend renaming into a collision).
- All operations are read-only/report-only; the script never edits source.

## Testing & verification plan

1. `pnpm --filter @muse/tools test` — the deterministic core test is green.
   It includes self-verification fixtures that need **no live model**:
   - (i) current `current_clock_value`, probe overwhelmingly yields `time_now`,
     candidate rate ≥ baseline+margin, no regression/collision ⇒
     `recommend:true, to:"time_now"`;
   - (ii) candidate beats baseline by **less** than margin ⇒ `recommend:false`;
   - (iii) candidate collides with a sibling ⇒ candidate rejected ⇒
     `recommend:false`;
   - (iv) candidate lifts T but regresses a sibling ⇒ `recommend:false`;
   - plus `normalizeToolName` / `tallyPeakedness` edge cases (quotes, mixed
     case, empty, all-invalid).
   This proves the decision logic ("fix it when warranted, leave it otherwise")
   independent of whether the real time tools are already optimal.
2. `pnpm lint` → 0 errors / 0 warnings.
3. **Live:** `pnpm calibrate:tools` against local Qwen prints the time-set
   report (Ollama-gated; if Ollama is down this step is deferred, not skipped as
   proof — per `testing.md`).
4. Apply any **warranted** rename to the real tool's `definition.name` (+ update
   the eval golden data / any test references), then `pnpm eval:tools`
   real-tools scenario score **≥ prior** (ideally improved). If calibration
   reports no rename warranted, `eval:tools` stays green and the report
   documents "names already model-peaked" — a valid verified outcome, because
   fixture (i) already proves the tool *would* recommend a fix when one exists.

## Decisions

- **Peakedness via generative-naming probe, not logprobs.** Ollama does not
  expose usable per-token logprobs, so PA-Tool's logprob "peakedness" is
  approximated by sampling the model's spontaneous naming distribution
  (temp > 0, N samples). The modal name is the peakedness signal.
- **Selection rate is the ground truth gate.** Discovery proposes; the
  `eval:tools`-style one-shot selection rate (temp 0) decides. A rename ships
  only when it beats the current name by a margin — this is what binds the
  research idea to Muse's existing, trusted verification.
- **Report-only, human-applied rename.** Keeps the tool fail-safe and keeps the
  diff reviewable; avoids a calibration script silently churning tool names.

## Acceptance check (the deliverable's proof)

- A green deterministic `packages/tools` unit test for the calibration core
  (the four decision fixtures + the normalize/tally edge cases).
- `pnpm calibrate:tools` runs end-to-end on local Qwen and emits a
  recommendation report for the time confusable set.
- `pnpm eval:tools` real-tools scenario is green at ≥ its prior score after any
  warranted rename is applied.
