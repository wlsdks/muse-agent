# 439 — Pin the `math_eval` no-eval arithmetic sandbox's rejection branches

## Why

`createMathEvalTool` (`@muse/tools` `muse-tools-data.ts`) is a
**security boundary**: it advertises "never invokes JavaScript
`eval`" and implements its own recursive-descent evaluator behind a
character whitelist (`MATH_EXPRESSION`). The whitelist + the
parser's rejection branches *are* the sandbox — every branch that
turns malformed input into a hard error instead of a confident
wrong number is load-bearing.

A read of the entire `math_eval` test block (`tools.test.ts`
919–981) confirmed only the happy path + a subset is pinned:
precedence/parens, the tab/newline whitespace class, unsafe-char
rejection, division-by-zero, multi-dot literal, well-formed
literals. **Zero assertions** existed on:

- the recursive-descent **trailing-characters keystone**
  (`if (cursor !== stripped.length) throw "trailing characters
  after expression"`) — the single branch where a refactor that
  returns the parsed *prefix* (the textbook recursive-descent bug)
  passes **every** existing test (all are fully-consumed
  expressions) while `2 3` silently becomes `2`, `1+2)` becomes
  `3`;
- **unbalanced parentheses** (`(1 + 2` → error, not the prefix);
- **modulo-by-zero** — a *distinct* `throw` from the covered
  division-by-zero;
- the **256-char limit off-by-one** (`> 256`: 257 rejected, 256
  still evaluates);
- the **non-string `required` guard** (`typeof === "string"`: a
  non-string arg must not be `String()`-coerced — `42` → `"42"`
  → `42` — but collapse to the actionable required-error).

This is the `.claude/rules/testing.md` "no implicit-only coverage"
class on a security-sensitive export, the exact 407 / 424 / 430 /
434 / 438 precedent. Non-speculative: the code is correct (probed
clean); this pins it so a future refactor cannot silently weaken
the no-eval sandbox.

## Slice

- `packages/tools/test/tools.test.ts` — one focused `it` inside
  the existing `createMuseTools` describe, adjacent to the sibling
  `math_eval` tests: trailing-chars (4 inputs, `toEqual({error})`
  exact so a leaked `result`/`expression` key fails), unbalanced
  parens (3), modulo-by-zero (3, incl. nested), the 256-char
  boundary in **both** directions (257 → limit error; exactly 256
  → no `error`, numeric `result`), and empty / whitespace-only /
  non-string / missing → `"expression is required"`.
- No `src` change — the sandbox is already correct.

## Verify

- `@muse/tools` tools.test.ts 71 (+1) | 1 skipped; tsc strict
  (tools) EXIT=0 (vitest esbuild masks type errors — run
  explicitly).
- **Mutation-proven teeth**: with the trailing-chars guard
  deleted, the new test goes RED (fails exactly on the
  `["2 3", …]` block, 1 failed / 70 passed); source then restored
  byte-identical via `git checkout` (empty `git diff --stat`),
  suite back to 71 green. The keystone assertion is not vacuous.
- `pnpm check` EXIT=0, every workspace green (tools 71, api 196,
  cli 737, …); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan of the changed file clean.
- Test-only, deterministic, pure local arithmetic — not a model
  request/response WIRE path; no `smoke:live` applies (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. The no-eval arithmetic sandbox's rejection/bounding
branches — the trailing-characters prefix-acceptance keystone,
unbalanced parens, modulo-by-zero, the 256-char off-by-one, and
the non-string required guard — now have direct, mutation-proven
unit coverage. A refactor that drops the cursor-at-end check,
flips the length boundary, or `String()`-coerces a non-string
input now fails a fast test instead of silently mis-evaluating
input the agent fed through a tool it trusts.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; this is test-coverage hardening of an
existing security mechanism, recorded honestly as a
`test(tools):` change with this backlog row — not a false metric
(the 434 / 438 precedent).

## Decisions

- Used `toEqual` (exact), not `toMatchObject`, on the
  trailing-chars and required cases: the discriminating property
  is the *absence* of a leaked `result`/`expression` key — exactly
  what a prefix-accepting refactor produces — and only an exact
  match catches that.
- Ran an explicit mutation check on the keystone branch rather
  than merely asserting the test "would" fail: "Verified or it
  does not exist" — a coverage test claimed to have teeth must be
  shown to have them. Restored the source byte-identical
  immediately (verified empty diff) so no mutation shipped.
- Did **not** "fix" the comma-strip edge (`3,5` → `35`): it is
  the documented thousands-separator contract (`1,000 + 1` →
  `1001` is intended; `,` is whitelisted for grouping). Changing
  it would break the documented case and is speculative
  defensive churn the iteration-loop contract bans — explicitly
  declined, not overlooked.
