# 480 — direct coverage for `ToolCallDeduplicator` + `stableJson` (test-only; 458/460/462/477/479 class)

## Why

`ToolCallDeduplicator` (`@muse/agent-core`
`tool-call-deduplicator.ts`) memoizes the result of completed
tool calls keyed by `<name>:<canonical-args>` so the agent's
tool loop never re-executes a verbatim repeat. It's a
correctness *and* safety helper: a long agent loop without it
re-runs side-effecting tools, doubles cost, and burns the step
budget (479).

The dedup contract has several non-trivial clauses:

- **key-reorder independence** in `stableJson` — `{a,b}` and
  `{b,a}` must collide; this is the central guarantee.
- **array-order preserved** (semantically meaningful — `[1,2]`
  ≠ `[2,1]`).
- **only completed memoized** — `blocked`/`failed` results are
  intentionally NOT cached so the agent can retry recoverable
  failures.
- **id/name rewrite on a duplicate hit** — the returned result
  carries the *current* call's id/name so the caller's
  correlation stays intact.
- **bounded FIFO eviction at `maxEntries`** + finite-guard so a
  non-finite constructor arg can't silently restore unbounded
  caching.

The module had **zero direct test coverage**:
`packages/agent-core/test/tool-call-deduplicator*.test.ts`
didn't exist and no other agent-core test imported the module.
Every clause above was implicit-only — a regression on
key-reorder (very plausible: someone "simplifies" away the
`.sort()`) would silently miss every dedup hit, doubling tool
invocations across the loop with **no test catching it**. Same
458/460/462/477/479 sanctioned class: real
safety/correctness-critical path, multi-clause contract,
mutation-provable. No `.ts` source change.

## Slice

- `packages/agent-core/test/tool-call-deduplicator.test.ts` —
  new file, 11 focused tests across:
  - **`stableJson` canonicalization** — top-level key-order
    independence, nested-level independence, array-order
    preserved, primitive / null / mixed nested rendering.
  - **dedup decision** — first call not-duplicate, second
    identical call duplicate; the returned result carries the
    CURRENT call's id/name; key-reordered args collide; same
    args with different tool names do NOT collide.
  - **memoization gating** — only `completed` is cached;
    `blocked` / `failed` are skipped so the agent retries.
  - **eviction** — exceeding `maxEntries` evicts the oldest
    (FIFO); a non-finite constructor argument coerces to the
    default 256 rather than silently disabling eviction.
- `packages/agent-core/src/tool-call-deduplicator.ts` —
  **unchanged** (`git diff --stat` empty; test-only iteration
  mirroring goals 458/460/462/477/479 verbatim).

## Verify

- New test 11/11 green; full `@muse/agent-core` suite green
  (was 605 → +11 → expected 616 in the per-package run; 0
  failed); tsc strict (agent-core) EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the `.sort()`
  in `stableJson`'s object branch makes **4 tests** fail with
  the precise pre-fix symptoms (`expected '{"a":1,"b":2}' to be
  '{"b":2,"a":1}'`, the same for the nested + mixed cases, AND
  the dedup integration test `expected { duplicate: false } to
  match object { duplicate: true }` — proving the central
  contract clause both at the helper level and end-to-end at
  the dedup level) while the other 7 stay green; source
  restored byte-identical, suite back to 11 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the one
  intended test file (src is unchanged).
- Pure deterministic dedup logic — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. The agent loop's tool-call dedup memoizer — the helper
that stops the model from re-running a verbatim tool call and
caps the step-budget burn from repeats — now has direct coverage
across canonicalization, decision, memoization gating, and
eviction; the central key-reorder-collision clause is
mutation-proven both at `stableJson` directly and end-to-end at
`ToolCallDeduplicator.check`.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 458/460/462/477/479-class direct
coverage addition on a zero-coverage correctness helper,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Mutation-proved the `.sort()` in `stableJson`'s object branch
  rather than (say) the `result.status !== "completed"` gate:
  the sort is the *central, easy-to-regress* clause (a future
  author "simplifies away" the sort and every kwarg-reordering
  hit silently misses); the completion gate is enforced by a
  literal status string compare and is much less likely to
  drift. The sort mutation also produces 4 simultaneous test
  failures across `stableJson` + the dedup integration, proving
  the contract end-to-end in a single mutation pass.
- Test-only (no source change); source restored byte-identical
  (`git diff --stat` empty for `tool-call-deduplicator.ts`) —
  mirrors the 458/460/462/477/479 protocol exactly.
- Used real public types (`ModelToolCall`, `ToolExecutionResult`)
  from `@muse/model` / `@muse/tools` rather than fabricated
  shapes — so the test would also catch a future type-shape
  drift at the contract boundary.
