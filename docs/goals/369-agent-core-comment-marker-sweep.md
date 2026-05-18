# 369 — strip iteration/round/goal provenance from agent-core comments

## Why

`.claude/rules/code-style.md` makes round/iteration/goal markers in
source a **hard rule** ("`// Goal 158 —`, `round 167`, `iter #57` …
In source it is pure rot and noise"). The 2026-05-15 sweep
(commits e890f2d / 0c1b7cd) removed `// Goal NNN` *line* comments
but did **not** touch the same provenance living inside JSDoc /
block comments (`* Goal 145 —`) or the prose forms
(`Round 3 pattern iter 22 used …`, `Before iter 35 …`,
`Iter 8 stamped …`). A repo-wide scan shows ~110 non-test
`src/*.ts` files still carry these — the sweep memory's "0 markers
remain / COMPLETE" is stale and conflicts with the working tree.

Cleaning the whole ~110-file backlog in one iteration would be a
huge, hard-to-verify diff. This iteration takes the
**highest-leverage coherent slice**: `packages/agent-core/src/*` —
the model-agnostic core runtime, the code most heavily read by the
AI agents this codebase is built for, where the comment-policy
rationale (markers burn context-window budget and lower
signal-to-noise without adding anything `git blame` /
`CHANGELOG.md` / `docs/goals` don't already carry) applies
maximally.

## Scope

16 provenance citations stripped across 8 agent-core files
(comment text only — **zero** behaviour, signature, or logic
change):

- `active-context.ts` ×3, `attachment-context.ts` ×3,
  `episodic-recall.ts` ×2, `inbox-context.ts` ×3, `model-loop.ts`
  ×2, `runtime-helpers.ts` ×1, `tool-filter.ts` ×1,
  `telemetry-aggregator.ts` ×1.

Method (same as the 2026-05-15 sweep): a citation that was pure
history ("same injection class iter 13/14/15/20 already closed",
"Same Round 3 pattern iters 22/24/33/34") was deleted outright —
the real WHY (defensive sanitisation against a
`\n[System Override]\n` splice from a third-party-pluggable
provider) was already stated in the same comment. Where the
iteration framing wrapped a genuine non-derivable WHY (the
episodic-recall CJK character-class rationale; the `tool-filter`
case-asymmetry bug; the `model-loop` tool-output cap), the WHY was
rewritten to stand on its own without the `iter NN` / `round NNN`
reference. `agent-core/src/*` is now fully marker-free
(case-insensitive scan of `goal|round|iter|iters|iteration` +
digits → none).

## Verify

- `pnpm --filter @muse/agent-core test` — 540 pass, 39 suites
  (unchanged: comment-only).
- `pnpm check` — every workspace green (apps/cli 647 incl. the
  `test/` glob, apps/api 165, all packages).
- `pnpm lint` — exit 0.
- goal-227/328 byte scan clean on every touched file.
- No real-LLM request/response path touched — comment text only.
  The unchanged full green suite is the rigorous verification that
  nothing but comments moved.

## Status

done — `packages/agent-core/src` carries zero round/iter/goal
provenance markers; the genuine WHY content is preserved, the
history rot is gone. The stale `project-comment-sweep` memory has
been corrected to record that the block-comment marker class was
never swept and remains a standing backlog (~110 files) across the
rest of the tree, with agent-core now the first package fully
cleaned of it.
