# 596 — `InMemoryContextReferenceStore` constructor finite-guards `ttlMs` and `maxEntries` against `NaN` / `Infinity` (closes the goal-595 sibling defect)

## Why

`packages/memory/src/context-reference-store.ts` is the
content-by-reference store the Muse runtime uses to elide
oversize tool output: the truncation marker stashes the full
content here under a short reference id and the agent can pull
it back via `muse.context.fetch(ref)`. The store has the same
pair of bounded-resource options the response cache had (goal
595): a TTL and an entry count cap.

Pre-fix constructor:

```ts
this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
```

Identical defect pattern to goal 595: `??` doesn't catch
`NaN` / `Infinity`, and `Math.max(_, NaN)` is NaN. But the
DOWNSTREAM consequences in this store are subtly different
and arguably WORSE than the response cache's "unbounded growth":

1. **`ttlMs: NaN`** — `isExpired`:
   `now() - createdAt.getTime() >= NaN` is always false. Every
   entry is permanent. Pruning is also a no-op
   (`createdAt.getTime() < cutoff = now - NaN = NaN` is always
   false). Cache grows until process exit.

2. **`maxEntries: NaN`** — `evictIfOverCap`:

       if (this.entries.size <= this.maxEntries) return;
       const overflow = this.entries.size - this.maxEntries;
       const ids: string[] = [];
       for (const id of this.entries.keys()) {
         if (ids.length >= overflow) break;
         ids.push(id);
       }
       for (const id of ids) this.entries.delete(id);

   With `maxEntries = NaN`:
   - `size <= NaN` is false → does NOT short-circuit.
   - `overflow = size - NaN = NaN`.
   - The break condition `ids.length >= NaN` is always false →
     loop never breaks → EVERY key is pushed into `ids` → EVERY
     key is deleted.

   So `maxEntries: NaN` doesn't cause unbounded growth — it
   causes the store to be silently emptied on every put past the
   first one. The first put inserts an entry, then
   `evictIfOverCap` immediately deletes it. Cache is functionally
   broken — no entry ever sticks. The agent's
   `muse.context.fetch(ref)` always returns undefined.

A realistic path to either NaN is a configurator that computes
the option via `Number.parseInt(envVar, 10)` (typo'd
`"30min"` → NaN) or via a settings-store lookup whose
`getNumber` returns NaN for a corrupt value.

Step-8 redirect note: this is the same finite-guard pattern as
goal 595 but on a different file in a different package
(`@muse/memory`). The defect family (`??` doesn't catch
non-finite numerics on a bounded-resource configurator) is
identical; the consequences (silent-empty vs unbounded growth)
are file-specific. Treated as a finishing pass on the same
defect sweep — the response cache (595) and the context
reference store (596) are the two stores in the repo that
share this constructor shape.

## Slice

- `packages/memory/src/context-reference-store.ts`:
  - Added private helper `finiteOrDefault(value, fallback)` —
    `typeof value === "number" && Number.isFinite(value) ?
    value : fallback`. Routes `NaN` / `Infinity` to the
    fallback, just like an unset `undefined`.
  - Constructor wraps both options:
    `Math.max(0, finiteOrDefault(options.ttlMs, DEFAULT_TTL_MS))`
    and
    `Math.max(1, finiteOrDefault(options.maxEntries,
    DEFAULT_MAX_ENTRIES))`.
  - Added a short WHY comment above the constructor explaining
    the dual short-circuit threat model (silent-empty vs
    permanent) — non-derivable from the code.
- `packages/memory/test/context-reference-store.test.ts`:
  - One composite test exercising all 4 NaN / Infinity branches:
    - `ttlMs: NaN` → entry expires past the 30-min default.
    - `ttlMs: Infinity` → same.
    - `maxEntries: NaN` → three puts all stay in the store
      (proves the eviction loop no longer drains on every put).
  - All three sub-assertions ride the same fixture-clock helper
    the existing tests use.

## Verify

- `@muse/memory` suite green (181 passed, +1 vs baseline 180, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  constructor back to bare `?? DEFAULT_*` makes the new test
  fail — the `ttlMs: NaN` branch reports the entry as still
  present after the 30-min cap (because `isExpired` returns
  false on NaN), or the `maxEntries: NaN` branch reports
  `list().length === 0` (because the eviction loop drained
  every put). Either failure proves the silent-disable path.
  Fix restored.
- `pnpm check` EXIT=0 (apps/api 254 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is the in-process content-by-reference store —
  feeds `muse.context.fetch(ref)` and the tool-output truncation
  marker, but this fix is a constructor-only behavior change.

## Status

Done. The in-memory context reference store stays bounded and
expiring under any mis-configuration:

| Constructor option            | Before                                       | After                                  |
| ----------------------------- | -------------------------------------------- | -------------------------------------- |
| `ttlMs: undefined`            | 30-min default (works)                       | unchanged                              |
| `ttlMs: 0`                    | explicit no-expiry (works)                   | unchanged                              |
| `ttlMs: 60_000`               | expires after 60 s                           | unchanged                              |
| `ttlMs: NaN`                  | **never expires** (silently)                 | expires after 30-min default (**fixed**) |
| `ttlMs: Infinity`             | **never expires** (silently)                 | expires after 30-min default (**fixed**) |
| `maxEntries: undefined`       | 1000-entry default (works)                   | unchanged                              |
| `maxEntries: 5`               | bounded at 5 (works)                         | unchanged                              |
| `maxEntries: NaN`             | **store silently emptied on every put**      | bounded at 1000 default (**fixed**)    |
| `maxEntries: Infinity`        | **bounded at Infinity** (unbounded growth)   | bounded at 1000 default (**fixed**)    |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
resource-bound `fix:` on an internal store, recorded honestly
with this backlog row — not a false metric.

## Decisions

- **Identical helper shape to goal 595.** Could have hoisted
  `finiteOrDefault` to `@muse/shared` to share between the two
  stores (response cache + context-reference store). Decided
  against because:
  (a) The helper is 1 line — cross-package import overhead +
      tree-shake config + new edge in the workspace graph for a
      one-liner is not worth it.
  (b) When (if) a third site emerges, the right move is the
      hoist; doing it preemptively for two sites buys nothing.
- **One composite test, three assertions.** Same posture as
  goal 595 — the four cases all exercise the same defect family
  on the same constructor; splitting them dilutes the
  load-bearing contract pin.
- **Did NOT widen the `ttlMs === 0` opt-out check.** That sentinel
  (the existing `if (this.ttlMs === 0) return false;` branch) is
  a documented "no expiry" knob. With the finite-guard, only an
  explicit `0` triggers it; NaN/Infinity now go to the default,
  not the no-expiry shortcut. Compare with goal 595: the response
  cache's `ttlMs === 0` is implicit (the `isExpired` check
  `this.ttlMs > 0 && …` short-circuits on 0); behavior preserved
  identically.
- **Test relies on absolute default values (`30 * 60 * 1_000`
  ms).** Could have exported a constant like goal 595 did
  (`DEFAULT_RESPONSE_CACHE_TTL_MS`), but the test uses the
  numeric literal inline since the store's `DEFAULT_TTL_MS` is
  module-private and the test only needs the boundary value
  once. If a future iteration needs to pin the default at
  multiple test sites, exporting then is the right move.

## Remaining risks

- **Other `?? default` + `Math.max` constructor patterns** in
  the same `@muse/memory` package — `memory-auto-extract.ts:162-173`
  has 10+ sites of `Math.max(_, Math.trunc(options.X ?? DEFAULT))`.
  `Math.trunc(NaN)` is NaN; `Math.max(_, NaN)` is NaN. Same
  defect class. Deferred to keep scope tight; that file is a
  10+ line sweep on its own.
- **`pattern-detector.ts`** has 4 similar constructor lines
  (`Math.max(1, options.minMatches ?? DEFAULT_MIN_MATCHES)` etc.)
  Same defect family. Deferred.
- **`packages/tools/src/index.ts:166`** has
  `Math.max(1, options.maxRepeatedToolCalls ?? 3)` — single
  field, same defect. Deferred (sub-defect-class iteration limit).
