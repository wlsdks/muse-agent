# 403 — Harden the objectives-daemon verdict parser (provider-agnostic, unattended-safe)

## Why

`parseObjectiveVerdict` is the verdict reader for the **autonomous,
unattended** objectives daemon (P9-b2), and the daemon runs over
ANY of Muse's 7 model families — not just reasoning-off qwen3. The
old extractor was a single greedy `/\{[\s\S]*\}/`. Concrete,
demonstrable failure (now pinned as a regression test):

```
<think>maybe {state: open}? after 3pm so yes</think>
{"outcome":"met"}
```

The greedy regex spans from the FIRST `{` (inside `<think>`) to
the LAST `}`, `JSON.parse` throws, and it returns the conservative
`unmet` safe default — so a genuinely **MET** objective would
NEVER complete or notify. `<think>` leakage and ```json fences
are the two most common LLM output shapes, so this silently broke
a class of objectives for any thinking/fenced provider. This is a
correctness gap in a delivered+audited capability, not a
hypothetical — the prompt's "refining / hardening an existing
feature (robustness, edge cases)" axis.

## What changed (behaviour-preserving on the clean path)

`parseObjectiveVerdict` now:
- strips `<think>…</think>` blocks and markdown code fences first;
- scans ALL balanced top-level `{…}` spans with a string-aware
  brace scanner (a `}` inside a JSON string value no longer closes
  the object early; two objects yield two candidates, not one
  over-wide invalid span);
- takes the LAST candidate that JSON-parses with a recognised
  `outcome` (a "think then answer" model puts the real verdict
  last; a non-verdict object cannot shadow it);
- keeps the EXACT same conservative semantics: `met` /
  `unmeetable`(+reason) / everything ambiguous ⇒ `unmet`. Never
  crashes, never a false `met`/`unmeetable`.

No API change, no new dependency, no new LLM round-trip (pure
parser) — the live decision quality was already verified at goal
398; this only makes the parse robust to provider output SHAPE.

## Verify

- `@muse/mcp` objective-evaluator.test.ts 5/5: the 4 original
  strict/conservative assertions UNCHANGED + pass (clean JSON,
  prose-flanked unmeetable, plain unmet, no-reason unmeetable,
  garbage/unknown/broken ⇒ unmet) plus the new robustness `it`
  (```json fence; the `<think>`-wrap regression; prose either
  side; last-recognised-object-wins; `}`-in-string; a fenced
  non-verdict object still ⇒ conservative unmet).
- `@muse/mcp` 481 pass; tsc strict clean (ran proactively);
  `pnpm check` green across all workspaces (apps/cli 683, all
  packages); `pnpm lint` 0/0; `pnpm guard:core` clean.
- No request/response (LLM) path touched — deterministic parser.
  No smoke:live applies.

## Status

Done. The autonomous objectives daemon no longer silently
mis-reads a `met`/`unmeetable` verdict that arrives fenced or
reasoning-wrapped — so objectives complete/escalate correctly
across every provider, not only reasoning-off qwen3. `fix(mcp)`:
this corrects a latent silent-failure class in a delivered+audited
capability (P9-b2). No bullet flip / no CAPABILITIES line — it is
robustness hardening of an existing bullet, not a new one;
recorded honestly as a fix with a pinned regression test.

## Decisions

- Earlier (goal 401 era) I declined this hardening as speculative
  because reasoning-off qwen3 emits bare JSON. That reasoning was
  too narrow: `parseObjectiveVerdict` is provider-agnostic and the
  daemon is unattended, so a fenced/think-wrapped verdict is a
  realistic, common, observed failure CLASS — not a hypothetical.
  Re-evaluated with that lens, the fix is justified, not
  gold-plating; the regression test makes the failure concrete.
- A string-aware balanced scanner (not a fancier regex) avoids
  catastrophic backtracking and correctly handles `}` inside
  string values — the right primitive for untrusted model text.
- "Last recognised-outcome object wins" is the safe rule for
  think-then-answer models (verdict is last) and cannot be gamed
  by a leading non-verdict object; ambiguity still ⇒ `unmet`, so
  the conservative invariant (never false-act) is preserved.
- Different area from the prior briefing / P7-prod iterations
  (Step-8 anti-concentration) and a genuine correctness fix, not
  inward churn.
