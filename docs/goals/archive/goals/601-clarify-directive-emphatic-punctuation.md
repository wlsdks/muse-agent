# 601 — `detectUnderspecifiedRequest` recognises emphatic punctuation (`!`, `...`) on contentless imperatives — `do it!` is the same ambiguity as `do it.`, not a fresh well-specified request

## Why

`packages/agent-core/src/clarify-directive.ts:detectUnderspecifiedRequest`
is the pre-LLM heuristic that detects "an action with no clear
object or referent" — when fired, the agent prepends a system
directive steering the model to ask a clarifying question
instead of hallucinating an action.

The pre-fix regex ended each branch with `\.?$` — accepting only
zero or one period as terminator:

```ts
/^(?:please\s+)?(?:just\s+)?(?:do|handle|...)\s+(?:it|that|...)\.?$|^(?:go\s+ahead|...)\.?$/u
```

This silently let through every emphatic variant:

| Input         | Pre-fix     | Intent                                                |
| ------------- | ----------- | ----------------------------------------------------- |
| `do it`       | flagged ✓   | contentless imperative — clarify                      |
| `do it.`      | flagged ✓   | unchanged                                              |
| `do it!`      | **missed**  | same intent + emphasis — should also clarify          |
| `do it!!`     | **missed**  | same intent, more emphasis                            |
| `do it...`    | **missed**  | trailing ellipsis (thinking aloud / fade)             |
| `do it?`      | not flagged | question (user asking Muse to consider) — out of scope |

A user typing `do it!` in chat got the same hallucinated-action
behaviour the directive was designed to prevent — because the
detector returned `{ ambiguous: false }` on the trailing `!`.

Step-8 redirect: distinct defect class from the recent file-mode
sweeps (598/599), finite-guards (595/596), timeout-window
(600), boolean-spelling (597), and parity gaps (593/594). This
is a regex-coverage / UX heuristic widening on the agent
pre-prompt path.

## Slice

- `packages/agent-core/src/clarify-directive.ts:CONTENTLESS_IMPERATIVE`:
  - Replaced `\.?$` (zero or one period) with `[.!]*$` (zero or
    more periods / exclamation marks) at the end of BOTH
    alternation branches.
  - Question mark `?` is intentionally NOT in the class — a
    `?`-terminated form is the user asking Muse to confirm, not
    commanding. Firing the clarify-directive on a question would
    be circular ("the user is asking if I should X — let me ask
    them if I should X").
  - Added a short WHY comment above the regex spelling out the
    `[.!]*` choice and the explicit `?` exclusion.
- `packages/agent-core/test/clarify-directive.test.ts`:
  - Added 2 new `it(...)` blocks:
    1. "flags the same contentless imperatives with emphatic
       punctuation" — covers `do it!`, `just send it!!`,
       `handle that...`, `fix this!`, `sort it out!`,
       `take care of it!!`, `go ahead!`, `please update it.`,
       and `Do It!` (mixed case, since the existing
       `toLowerCase` normaliser handles that).
    2. "does NOT flag question-marked forms" — covers `do it?`,
       `handle that?`, `go ahead?`, `just send it?` and pins
       the intentional `?` exclusion so a future regex
       widening can't silently flip the contract.

## Verify

- `@muse/agent-core` suite green (659 passed, +2 vs baseline
  657, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the regex
  back to `\.?$` makes the "emphatic punctuation" test fail
  immediately (all the `!`/`...`/`!!` cases return ambiguous=
  false). The question-mark exclusion test is unaffected (both
  the pre-fix and post-fix regex reject `?`-terminators). Fix
  restored.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- The fix is a pre-LLM regex heuristic — it changes WHICH user
  messages trigger the clarify-directive system message, not
  the wire format itself. The clarify-directive system message
  shape is unchanged. `smoke:live` not required because this
  isn't a model-request shape change; the new tests pin the
  regex contract directly.

## Status

Done. The clarify-directive heuristic now matches every
contentless-imperative punctuation variant a user is realistically
likely to type:

| Input variant                  | Before        | After                        |
| ------------------------------ | ------------- | ---------------------------- |
| `do it`                        | flagged       | unchanged                    |
| `do it.`                       | flagged       | unchanged                    |
| `do it!` / `do it!!`           | **missed**    | flagged (**fixed**)          |
| `do it...`                     | **missed**    | flagged (**fixed**)          |
| `Do It!` (mixed case)          | **missed**    | flagged (**fixed**)          |
| `do it?` (question)            | not flagged   | unchanged (intentional)      |
| `do the Q3 report` (specific)  | not flagged   | unchanged                    |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
UX heuristic widening on the agent-core context-transform path,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **`[.!]*` over `[.!]?`** — allows multiple `!` (or mixed
  `.!`) because `do it!!` and `do it...` are realistic
  user emphasis. The 40-char input cap (line 18) bounds the
  total length so there's no regex-blow-up concern.
- **`?` intentionally NOT in the character class** — the
  semantics are distinct. `do it.` and `do it!` are commands
  (action declarations). `do it?` is the user asking Muse to
  consider doing it — which the LLM should answer directly,
  not ask back about. Pinned this contract with a dedicated
  test ("does NOT flag question-marked forms") so a future
  regex widening can't silently swallow questions.
- **Test inputs cover both regex branches.** The contentless-
  imperative regex has two top-level alternations: the
  `(?:do|handle|...)\s+(?:it|...)` form AND the
  `(?:go\s+ahead|just\s+do\s+it|...)` form. The new tests
  cover BOTH (`do it!` hits the first; `go ahead!` hits the
  second), so a future asymmetric edit that fixes only one
  branch would still fail the test.
- **Case sensitivity covered by existing normaliser.** The
  `Do It!` test case verifies the existing `text.trim().
  toLowerCase()` normaliser at line 17 still applies, so the
  new `[.!]*` class doesn't accidentally require lowercased
  exclamation. Pinned as belt-and-braces against a future
  refactor that might drop the lowercase pass.

## Remaining risks

- **Other emphatic terminators.** The detector now covers
  `.` and `!`. Other realistic forms include `~`, `^^`,
  emojis (`👍`), or trailing whitespace runs. These are
  exotic enough that the false-positive risk (firing on a
  legitimate well-specified request that happens to end with
  one) outweighs the false-negative cost. Deferred.
- **Multi-language coverage.** The regex matches English-only
  ("do it", "handle that"). A Korean user typing "처리해줘"
  (= "handle it") is missed. Adding multi-language coverage
  is a much larger redesign (tokenization, per-language verb
  / referent lists). The existing regex's comment calls out
  the "deliberately narrow" posture. Out of scope.
- **`applyClarifyDirective` short-circuit on a prior assistant
  turn (line 44)** — when an assistant message precedes the
  user's `do it!`, the directive is NOT prepended (interpreted
  as confirming a prior proposal). This wider regex doesn't
  change that short-circuit; existing test "does NOT fire when
  a prior assistant turn makes it a confirmation" still
  covers it.
