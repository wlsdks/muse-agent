# 446 — `ToolCallDeduplicator` bounds its result cache (434 sibling)

## Why

`ToolCallDeduplicator` (`@muse/agent-core`
`tool-call-deduplicator.ts`) memoizes completed
`ToolExecutionResult`s keyed by `<name>:<canonical-args>` so a
model re-emitting an identical call doesn't re-execute the tool.
It is instantiated per tool loop (`model-loop.ts:115` / `:218`),
so its lifetime is one agent run.

`record` did `this.#completedResults.set(...)` with **no cap and
no eviction**. Every *distinct* completed tool call's full result
(tool outputs can be large) is pinned for the whole run. Under the
project's autonomy mandate (the P5–P9 objectives daemon, long
research/agent runs with a high `maxToolCalls`), a run that issues
many distinct completed tool calls grows this map unbounded — a
runaway tool loop pins unbounded process memory in retained tool
outputs.

This is the exact memory-safety class goal 434 already fixed for
the sibling unbounded per-run cache `InMemoryContextReferenceStore`
("Bounded entry count so a runaway tool can't pin unbounded
memory"), and it is a CLAUDE.md non-negotiable ("Tool loops have
explicit limits and timeouts" — the dedup cache is part of the
tool loop and had no limit). The deduplicator is the second such
cache in the same tool-execution path lacking the bound 434
established as necessary — the 433 / 443 / 444 sibling-asymmetry
class, not a speculative guard: the codebase already decided this
class of unbounded per-run tool cache is a real hazard worth
bounding. A grep confirmed the existing `describe`
("ToolCallDeduplicator") covers reuse + no-cache-failed but has
**zero** assertions on a memory bound.

Fresh package/axis (agent-core last touched goal 436, ~10
iterations ago); a memory-bound `fix:`, distinct from the recent
NaN-guard streak; fully unit-verifiable (pure in-memory, no LLM).

## Slice

- `packages/agent-core/src/tool-call-deduplicator.ts` — a
  `maxEntries` constructor option (default `256`, generous enough
  that any realistic repeat-within-a-window still dedups) with a
  finite-guard (a non-finite cap would make `size > maxEntries`
  always false and silently restore the unbounded behaviour — the
  436/437/443 lesson, directly applicable to a numeric bound
  option). `record` evicts **oldest-first** (Map insertion order)
  once size exceeds the cap. Re-recording an existing signature
  updates in place (no growth, no spurious eviction). The two
  existing no-arg call sites get the default bound unchanged, so
  behaviour is identical for any run with ≤256 distinct completed
  calls (effectively all real runs); an evicted repeat simply
  re-executes — correct, only unmemoized (the dedup is an
  optimisation, never a correctness requirement), mirroring 434's
  graceful oldest-first degradation.
- `packages/agent-core/test/agent-runtime.test.ts` — a new `it`
  in the existing `ToolCallDeduplicator` describe: with
  `maxEntries: 2`, a third distinct completed call evicts the
  oldest (which then re-executes) while the two newest stay
  memoized; re-recording an existing signature updates in place
  without evicting the other retained entry; and a
  non-finite/non-positive cap (`NaN`, `0`, `-5`, `Infinity`)
  falls back to the default bound rather than an always-false
  (silently unbounded) check.

## Verify

- New `it` green; full `@muse/agent-core` suite 589 passed (48
  files, +1); tsc strict (agent-core) EXIT=0.
- **Mutation-proven teeth**: deleting the eviction block makes the
  new test fail with `expected { duplicate: true } to match
  { duplicate: false }` — i.e. without the bound the oldest is
  never evicted (the exact pre-fix unbounded behaviour);
  `keys().next().value` occurrence count went 1→0 then restored
  to 1, suite back to 589 green.
- `pnpm check` EXIT=0, every workspace green (agent-core 589,
  cli 737, api …) — no regression, confirming behaviour-identical
  for the common (≤cap) case and the default-cap model-loop call
  sites; `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan
  clean; `git status` shows only the two intended files.
- Pure in-memory data-structure logic — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. A long or runaway agent tool loop can no longer pin
unbounded process memory in retained tool outputs via the
dedup cache — it is now bounded oldest-first, the same protection
434 gave the sibling `InMemoryContextReferenceStore`, satisfying
the CLAUDE.md "tool loops have explicit limits" non-negotiable
for this cache. Dedup of recently-repeated calls (the real,
common case) is unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a memory-safety `fix:` to an existing
core agent mechanism (434 sibling), recorded honestly with this
backlog row — not a false metric.

## Decisions

- Oldest-first (insertion-order) eviction, not LRU: byte-parallel
  to 434's chosen policy, and a model's duplicate calls cluster
  within a short window, so insertion-order is the right proxy;
  an LRU touch-on-read would add bookkeeping for no real hit-rate
  gain at this scale.
- Default `256`, not 434's `1_000`: each entry holds a full tool
  output (larger than a context-ref id) and models repeat calls
  within a few turns, not hundreds apart — 256 covers any
  realistic interleave while bounding worst-case retained output
  tighter. Configurable via the constructor for any caller that
  needs a different window.
- Finite-guarded the option deliberately: omitting it would let a
  bad `maxEntries` reintroduce the very unbounded bug through the
  new option (the 436/437/443 footgun), so the guard is part of
  the fix, not scope creep.
