# 434 — Direct coverage for the context-reference store's eviction safety

## Why

`InMemoryContextReferenceStore` (`@muse/memory`
`context-reference-store.ts`) is the in-process content-by-
reference store the cap-tool-output path stashes elided bytes
into. Its docstring states two **memory-safety** invariants: "TTL
eviction so a long-running process doesn't accumulate stale large
blobs" and "Bounded entry count so a runaway tool can't pin
unbounded memory" — and it ships an injectable `now` clock
explicitly "useful for tests". But the only consumers
(`cap-tool-output.test.ts` ×3, plus barrel imports) exercise just
the put/fetch flow; a grep confirmed **zero** assertions on
`pruneExpired` / `evictIfOverCap` / TTL-expiry-on-get /
`ttlMs:0` / the empty-id guard.

So the safety bounding was implicit-only coverage — exactly what
`.claude/rules/testing.md` forbids ("direct unit tests for every
export … no implicit-only coverage"; goals 407 / 424 / 430
precedent). A refactor that evicted newest-first, was off-by-one
on the cap, skipped TTL on `get`, or made `pruneExpired`
non-idempotent would let a runaway tool pin unbounded memory (or
silently drop live refs) with nothing failing. Non-speculative:
the code is correct; this pins it so it stays correct.

## Slice

- `packages/memory/test/context-reference-store.test.ts` (new, 6
  cases, deterministic via the injected clock):
  - put → get round-trip + empty-id guard throws;
  - lazy TTL expiry on `get` once past the TTL, and the expired
    entry is actually deleted (verified via `list()`);
  - `ttlMs:0` disables expiry entirely (long-elapsed `get` still
    hits; `pruneExpired` → 0);
  - `pruneExpired` removes only expired entries, returns the
    count, and is idempotent (second call → 0);
  - over `maxEntries` → the **oldest** entries are evicted first
    (insertion order), newest retained;
  - `delete` reports whether the entry existed.

## Verify

- `@muse/memory` context-reference-store.test.ts 6/6; full
  `@muse/memory` suite green (13 files / 167, +1 file +6); tsc
  strict (memory) clean.
- `pnpm check` EXIT=0, every workspace green (memory 167, api
  195, cli 737, …); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the new test file
  (no `src` change).
- Test-only, deterministic (injected clock) — not a model
  request/response path; no `smoke:live` applies.

## Status

Done. The context-reference store's TTL + bounded-entry eviction
— the mechanism that stops a runaway tool from pinning unbounded
process memory — now has direct unit coverage of every branch
(TTL on get, prune, oldest-first cap eviction, ttl-disabled,
empty-id), matching the testing-rule and the 407/424/430
precedent. A refactor that weakens the bounding now fails a fast
test.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; test-coverage hardening of an existing safety
mechanism, recorded honestly as a `test(memory):` change with
this backlog row — not a false metric.

## Decisions

- Imported directly from `../src/context-reference-store.js`
  (not the barrel) so this is a true module-level unit test of
  the store's own exports — the goal-407/424/430 discipline.
- Pinned the oldest-first eviction order explicitly: it is the
  one behaviour where a refactor (newest-first) would be subtly
  wrong yet pass any put/fetch happy-path test — the highest-
  value branch to lock.
