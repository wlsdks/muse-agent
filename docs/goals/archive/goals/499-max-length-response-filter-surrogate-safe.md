# 499 — `createMaxLengthResponseFilter` drops a lone high surrogate at the truncation boundary (goal-451 sibling)

## Why

`createMaxLengthResponseFilter` (`@muse/agent-core`
`response-filters.ts:65`) caps the final model response at
`maxLength` UTF-16 units before the runtime hands the answer
back to the surface (`/api/chat`, SSE consumer, persistence,
messaging providers). Pre-fix:

```ts
output: `${response.output.slice(0, maxLength)}\n\n[Response truncated]`,
```

`String.prototype.slice` operates on **UTF-16 code units**, not
code points. If `maxLength` falls inside a surrogate pair
(every emoji like `😀` is U+1F600 stored as a high `\uD83D` +
low `\uDE00` pair), the slice emits a **lone high surrogate**.
That's invalid UTF-8: a downstream JSON body, an SSE frame, or
a persistence write that encodes through `Buffer.from(value,
"utf8")` either replaces it with U+FFFD or — on a stricter
target like Telegram / Discord — 400s the whole response.

Real, reachable: a Korean / emoji-heavy reply (`"안녕하세요 😀
오늘 일정 3건입니다"`) capped at any byte boundary that lands
inside the emoji's surrogate pair silently corrupts the
user-facing answer.

This is the exact goal-451 surrogate-guard pattern that
`@muse/shared` `truncateErrorBody` already implements — same
defect, same shape, on a different consumer (response output
vs. error body).

## Slice

- `packages/agent-core/src/response-filters.ts` — after the
  `slice(0, maxLength)` call, check `charCodeAt(head.length -
  1)` for a high surrogate (`0xd800-0xdbff`) and drop it with
  another `slice(0, -1)`. Same byte-identical pattern as
  goal-451's `truncateErrorBody` fix. Behaviour byte-identical
  for every truncation that doesn't land on a surrogate
  boundary (the overwhelming common case).
- `packages/agent-core/test/max-length-response-filter.test.ts`
  — new file, 5 focused tests pinning: no-op when output
  fits / maxLength is 0 / maxLength is unset; truncates plain
  ASCII at the documented boundary; **drops a lone high
  surrogate when the cap lands inside `😀`** (the goal-451
  sibling, the central new clause); preserves an emoji fully
  inside the head (not over-trimmed).

## Verify

- New test 5/5 green; full `@muse/agent-core` suite green (631
  passed, +5, 0 failed); tsc strict (agent-core) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  surrogate-drop block (returning to a plain
  `response.output.slice(0, maxLength)`) makes the surrogate
  test fail (its assertion that the emitted body equals
  `"ab\n\n[Response truncated]"` and not
  `"ab\uD83D\n\n[Response truncated]"`) while the other four
  tests stay green; fix restored, suite back to 5 green.
- `pnpm check` EXIT=0, every workspace green — no regression
  across the response-filter consumers (the prior
  `agent-runtime.test.ts` ASCII-truncation assertion stays
  green by construction); `pnpm lint` 0/0; `pnpm guard:core`
  clean (no IMMUTABLE-CORE touched); byte-scan clean;
  `git status` shows only the two intended files.
- Pure response-rewriting — no LLM / model request-response
  wire path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A model reply containing a multi-byte character at the
truncation boundary no longer emits a lone surrogate to
downstream JSON / SSE / messaging frames. The goal-451
surrogate-guard pattern now covers the second consumer of the
same defect class. Every truncation that doesn't land on a
surrogate boundary is byte-identical.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a goal-451 sibling correctness
`fix:` on the response-rewriting layer, recorded honestly with
this backlog row — not a false metric.

## Decisions

- Mirrored the goal-451 `truncateErrorBody` fix shape
  byte-for-byte (charCodeAt + range check + slice -1)
  rather than introducing a new code-point-aware loop: the
  two defects are the same problem on different consumers; a
  divergent fix would be exactly the drift that single-pattern
  rollouts exist to prevent.
- Dropped the orphan rather than appending U+FFFD: callers
  read the truncated body as text and care about valid UTF-8
  more than preserving a "where the cut happened" marker;
  the trailing `\n\n[Response truncated]` already conveys the
  truncation, so a U+FFFD substitution would just add noise.
- Tested both directions of the surrogate boundary — the
  emoji-inside-head case AND the emoji-at-boundary case — so a
  future "simplify the check" PR has to satisfy both
  semantics, not just one.
