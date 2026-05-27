# 457 — An empty keyword can't make an agent spec match every task

## Why

`scoreAgentSpec` (`@muse/agent-specs`) is the routing scorer that
decides which named agent spec handles a task
(`RuleBasedAgentSpecResolver` → confidence ranking). It matched
keywords with:

```ts
spec.keywords.filter((keyword) => normalizedText.includes(normalizeText(keyword)))
```

`normalizeText("")` (or a whitespace-only keyword) is `""`, and
`anyString.includes("")` is **always true**. So a single empty /
blank keyword makes the spec match **every task** with inflated
confidence — silently hijacking JARVIS sub-agent routing for all
requests.

The create path (`normalizeAgentSpecInput`) sanitises keywords
via `uniqueStrings` (trim + drop empties). But the **load path
does not**: `mapAgentSpecRow` → `toStringArray` keeps every
string, including `""` / `"  "`. So a persisted / legacy /
hand-edited `agent_specs` row, or an API/UI that posts
`keywords: ["", "billing"]`, reaches `scoreAgentSpec` with an
empty keyword and the bug fires. This is the 433 / 441 / 453
"the load path doesn't re-apply the normalize-path invariant"
class, reachable and concrete (not speculative —
`includes("")===true` is deterministic and the load path
demonstrably yields empty keywords), on the agent-routing
chokepoint. Fresh package (agent-specs never functionally
touched this session); the existing `scoreAgentSpec` test covered
only a happy-path match, so the empty-keyword case was
**genuinely uncovered**.

## Slice

- `packages/agent-specs/src/index.ts` — `scoreAgentSpec` now
  skips a keyword whose normalized form is empty (`needle.length
  > 0 && normalizedText.includes(needle)`). Fixed at the **single
  scoring chokepoint** so the invariant holds regardless of how
  the spec was constructed (Kysely store, direct construction,
  future paths) — the 441 / 453 single-chokepoint rationale —
  not just patched on one loader. Behaviour byte-identical for
  every non-empty keyword (the normal `normalizeAgentSpecInput`
  path); an empty keyword simply stops counting as a match
  (correctly lowering, not inflating, confidence).
- `packages/agent-specs/test/agent-specs.test.ts` — a new `it`
  building the realistic vulnerable spec via `mapAgentSpecRow`
  with `keywords: ["", "billing"]`: an unrelated task →
  `undefined` (was a 0.5-confidence false match); a real
  `"billing"` task → matches only `["billing"]`, not the empty
  keyword.

## Verify

- New `it` green; full `@muse/agent-specs` suite 14 passed
  (+1); tsc strict (agent-specs) EXIT=0.
- **Clean-mutation-proven** (Edit-based, not perl): reverting the
  guard makes the new test fail with exactly
  `AssertionError: expected { confidence: 0.5, …(2) } to be
  undefined` — the precise pre-fix routing hijack (the `""`
  keyword matched a totally-unrelated task at confidence 0.5);
  fix then restored, suite back to 14 green.
- `pnpm check` EXIT=0, every workspace green (agent-specs 14,
  cli 739, api …) — no regression in the api/cli consumers;
  `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean;
  `git status` shows only the two intended files.
- Pure deterministic scoring logic — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. A junk empty keyword on a stored/legacy/API-supplied agent
spec no longer makes that spec out-rank everything and capture
every task's routing; real keywords still match exactly as
before. The keyword-sanitisation invariant the create path
already enforced is now enforced where it actually matters — the
scoring chokepoint — for every spec source.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a routing-correctness `fix:` to an
existing mechanism (433/441/453 load-path-invariant class),
recorded honestly with this backlog row — not a false metric.

## Decisions

- Guarded at `scoreAgentSpec` (the chokepoint all spec sources
  funnel through), not by trim/filtering `toStringArray` in the
  Kysely loader: the loader fix would miss direct construction
  and any future loader; the scorer is where the
  `includes("")` footgun actually bites, and one guard there is
  drift-proof (the 441/453 rationale).
- Left the empty keyword in the confidence **denominator**
  (`spec.keywords.length`): excluding it from matches is the
  unambiguous fix; re-deriving the denominator is a separate,
  debatable scoring-tuning question deliberately not scope-crept
  — a spec carrying junk keywords being slightly less confident
  is acceptable, not wrong.
