# 506 — direct test coverage for `HookRegistry` (zero-coverage class on the agent-core hook plumbing)

## Why

`packages/agent-core/src/hook-registry.ts` is the 23-LOC class
that holds every dynamically-registered `HookStage` in the
runtime. It is consumed by `agent-runtime.ts` and merged with
static hooks via `mergedHooks()` — every agent run that hooks fire
at (`beforeStart`, `beforeTool`, `afterTool`, `afterComplete`,
`onError`) reads from a `HookRegistry`. Pre-iteration it had
**zero direct unit tests**: its behaviour was implicitly covered
by runtime integration tests (`agent-runtime.test.ts`) and the
`mergedHooks` test in `hook-orchestration.test.ts` used a fake
`{ list: () => [...] }` rather than the real class.

The class encodes four behavioural contracts the runtime relies on:

1. **Constructor seeds from an iterable** — every entry passed in
   gets registered.
2. **`register(hook)` is last-writer-wins by `id`** —
   `Map.set(id, hook)` REPLACES an existing entry. The runtime
   relies on this for the `mergedHooks` override-by-id semantics
   (the dynamic registry shadows static hooks with the same id).
   A future refactor to "ignore if present" or "throw on
   duplicate" would silently break override.
3. **`unregister(id)` returns `boolean`** — `true` if removed,
   `false` if absent. Callers that branch on the return need this
   to be honest.
4. **`list()` returns a SNAPSHOT** — the spread `[...]` makes the
   returned array safe to mutate; the iterator over the underlying
   Map is not exposed. A future change to `Array.from(this.hooks.
   values())` is identical; a change to return the live iterator
   would silently leak mutation through callers.

Same 458-class iteration as 458/460/462/477/479/480/485/487/491/
492/496/498/504 — direct coverage of a zero-coverage class on a
runtime-hot path.

## Slice

- `packages/agent-core/src/hook-registry.test.ts` — new file, 7
  focused tests:
  - constructor seeds from iterable
  - constructor defaults to empty iterable (no-arg)
  - `register` adds a hook visible via `list`
  - `register` REPLACES on duplicate id (last-writer-wins)
  - `unregister` returns `true` then `false` on second call
  - `unregister` returns `false` for an id never registered
    (no throw)
  - `list` returns a snapshot — mutating the returned array does
    not affect the registry

Source `packages/agent-core/src/hook-registry.ts` is byte-identical
to HEAD — test-only iteration.

## Verify

- New test 7/7 green; full `@muse/agent-core` suite green
  (639 passed, +7 vs baseline 632, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): mutating `register` to
  `if (!this.hooks.has(hook.id)) this.hooks.set(hook.id, hook)`
  (first-writer-wins) makes the "register REPLACES" test fail
  with the precise pre-mutation symptom (`expected { …(2) } to be
  { …(2) }` — the listed hook is `first` not `second`) while
  every other test stays green; fix restored, suite back to 7
  green.
- `pnpm check` EXIT=0; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the new test file.
- Pure unit coverage — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-loop
  Step 9).

## Status

Done. The four behavioural contracts of `HookRegistry` are now
directly asserted; a future refactor that silently shifts
register-on-duplicate semantics, drops the snapshot, or breaks the
boolean return of unregister will fail this file instead of
silently breaking the agent-runtime hook-override mechanism.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 458-class direct-coverage iteration
on a zero-coverage class, recorded honestly with this backlog
row — not a false metric.

## Decisions

- Step-8 redirect from the empty-env-shadow run (495/503/505) to
  a different defect class (zero-coverage class on agent-core).
  Same area would have been janitorial drift; different area
  with a different class is the productive variation Step 8
  protects.
- Mutation chose to flip `register` to first-writer-wins because
  that is the load-bearing line of the class — the runtime's
  override-by-id behaviour depends on it. A mutation on `list`'s
  snapshot would also work but require a less surprising test
  reframing.
- Used a `stub(id)` helper to elide the cost of writing five
  empty `HookStage` lifecycle methods per fixture — `id` is the
  only field the class actually reads.
- Did NOT add an Object.freeze on the returned `list()` snapshot:
  the existing `readonly HookStage[]` type already says don't
  mutate; the test asserts the runtime guarantee (the registry
  isn't affected), not the type guarantee. Adding freeze would be
  a behaviour change, not test-only.
