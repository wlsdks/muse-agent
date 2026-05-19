# 447 — A re-mentioned recent topic keeps its freshest position (persona continuity fix)

## Why

`buildMusePersona` (`apps/cli/muse-persona.ts`) renders the
"Recent topics the user has been working on" block injected into
the JARVIS system prompt — the mechanism whose own comment states:
"the user just spent 30 min talking about 'the Q3 budget memo'
and the next session has no idea … JARVIS-class continuity."

Line 82: `dedupeNonEmpty(memory.recentTopics ?? []).slice(-5)`.
The intent (documented in the surrounding comment): "Cap to the 5
**most recent** topics. The auto-extractor appends in
chronological order, so the **tail is the freshest**." But
`dedupeNonEmpty` kept the **first** occurrence. So for
`["alpha","b","c","d","e","f","alpha"]` — the user worked on
`alpha` early, ranged over b…f, then **returned to `alpha` most
recently** (it is the freshest entry, last in the array):

- first-occurrence dedupe → `["alpha","b","c","d","e","f"]`
  (`alpha` pinned to its **stale** front position)
- `.slice(-5)` → `["b","c","d","e","f"]` — **`alpha` dropped**

The persona block omits the very topic the user just resumed,
purely because they had also touched it earlier — directly
defeating the documented continuity rationale. This is the
425 / 433 "dedup keeps the wrong occurrence relative to the
recency intent" class, on a user-facing JARVIS-continuity
surface, and a different defect class from the recent
bound/NaN-guard run (probe/close-read, fresh package — persona
last touched goal 242).

## Slice

- `apps/cli/src/muse-persona.ts` — `dedupeNonEmpty` (private,
  single caller at line 82) now walks newest→oldest, keeping the
  **last** occurrence, then reverses to restore chronological
  order. A re-mentioned topic therefore keeps its freshest
  position so the caller's `slice(-5)` "most recent" cut retains
  it. Empty/whitespace skipping is unchanged.
- `apps/cli/src/muse-persona.test.ts` — a new `it`:
  `["alpha","b","c","d","e","f","alpha"]` → the recent-topics
  block is exactly `["  - c","  - d","  - e","  - f","  - alpha"]`
  ("alpha" retained as most-recent; "b", now the oldest of six
  distinct, correctly dropped by the cap).

## Verify

- New `it` green; the pre-existing
  "caps recentTopics to the 5 most recent" test still green —
  traced and confirmed behaviour-preserving for it (its
  duplicates are all the same trailing value, so first- vs
  last-occurrence land identically); full `@muse/cli` suite green
  (69 files, +1 it, 0 failed); tsc strict (cli) EXIT=0.
- **Mutation-proven teeth**: reverting `dedupeNonEmpty` to the
  first-occurrence forward loop makes the new test fail with
  exactly `AssertionError: expected '…' to contain '  - alpha'`
  (the precise pre-fix bug — the resumed topic dropped);
  `out.reverse()` occurrence count went 1→0 then restored to 1,
  suite back to green.
- `pnpm check` EXIT=0, every workspace green (apps/cli 69 files,
  api …) — no regression; `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean; `git status` shows only the two
  intended files.
- Pure deterministic persona-string assembly — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. JARVIS's "recent topics" continuity block now keeps a topic
the user just returned to, instead of discarding it because they
had also worked on it earlier in the same history — the documented
"the next session isn't amnesic" promise now actually holds for
re-visited topics. All other persona output is unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a correctness `fix:` to an existing
persona-continuity feature, recorded honestly with this backlog
row — not a false metric.

## Decisions

- Changed `dedupeNonEmpty`'s semantics in place (reverse-walk,
  keep-last, restore order) rather than adding a second helper:
  it is private with exactly one caller whose documented intent
  ("most recent") *is* last-occurrence-wins — first-occurrence
  was simply the wrong semantics for this single use, not a
  contract worth preserving.
- Asserted the exact 5-element ordered topic list (`toEqual`),
  not just `toContain("alpha")`: the ordering (freshest last,
  oldest-of-the-kept dropped) is the precise property a
  recency-aware dedupe must satisfy, and only an exact match
  pins both the inclusion and the position a future regression
  could break.
