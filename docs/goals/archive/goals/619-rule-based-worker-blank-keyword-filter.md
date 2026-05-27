# 619 — `RuleBasedAgentWorker` constructor filters empty / whitespace-only keywords so a stray blank slip can't score spurious match-confidence against unrelated inputs

## Why

`packages/multi-agent/src/index.ts:RuleBasedAgentWorker` is the
rule-based dispatcher the supervisor uses to route an
`AgentRunInput` to one of N specialised workers. Its `canHandle`
returns a confidence in `[0, 1]` computed as
`matched_keyword_count / total_keyword_count`. The constructor
pre-lowercased the keyword list:

```ts
this.keywords = keywords.map((keyword) => keyword.toLowerCase());
```

But it did NOT filter empty / whitespace-only entries. The
matcher then ran:

```ts
const matched = this.keywords.filter((keyword) => text.includes(keyword)).length;
```

`text.includes("")` is **universally true** by the spec — every
string contains the empty string. So a caller passing
`keywords: ["calendar", ""]` (a typo, a defaulted-from-empty
config row, a CSV split that produced a trailing empty cell)
would see `matched = 2` against ANY input — confidence = 1.0 —
regardless of whether `"calendar"` actually appeared.

The supervisor's selection rule is "highest confidence wins."
A blank-slip worker quietly hijacks every dispatch decision —
all because of one empty string in the keyword list.

User-visible symptom: an operator sets up two workers (`calendar`
keywords `["calendar", ""]` from a config file with a trailing
blank line, `research` keywords `["research"]`) and discovers
that ALL queries route to the calendar worker, including
"summarise the Q3 budget memo" and "write a bash script." There's
no diagnostic — the matcher returns 1.0 every time.

Step-8 redirect: not file-mode (616), not atomic-write (617),
not per-field cap (618), not boolean spelling (612), not date
overflow (613). Defect class is "input-list cleanup at
constructor — drop semantically-empty entries that would silently
poison the matcher" — fresh in the recent window.

## Slice

- `packages/multi-agent/src/index.ts:RuleBasedAgentWorker`:
  - Replaced the bare `keywords.map(k => k.toLowerCase())` with
    a three-step pipeline:
    ```ts
    this.keywords = keywords
      .map((keyword) => keyword.toLowerCase().trim())
      .filter((keyword) => keyword.length > 0);
    ```
  - `.trim()` AFTER `toLowerCase()` so whitespace-only entries
    (e.g. `"  "`) collapse to `""` and get filtered. Tab /
    newline characters are also caught by `.trim()`.
  - `.filter(length > 0)` is the single load-bearing line — it
    drops both `""` and `"  "` from poisoning the matcher.
- `packages/multi-agent/test/multi-agent.test.ts`:
  - One new test at the top of the `SupervisorAgent` describe.
    Constructs a worker with `keywords: ["calendar", "", "  ", "schedule"]`
    — two real keywords plus two blanks. Asserts:
    - Unrelated input (`"tell me a joke about programming"`)
      scores 0 (post-fix the blanks are gone, both real
      keywords miss). Pre-fix the empty-string keyword
      matched universally and inflated confidence to 0.25.
    - Partial-match input (`"what's on my calendar today?"`)
      scores 0.5 (1/2 real keywords matched).
    - Full-match input (`"schedule a meeting on my calendar"`)
      scores 1.0 — happy path stays unchanged.

## Verify

- `@muse/multi-agent` suite green (48 passed, +1 vs baseline 47,
  0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the filter
  back to the bare `map(toLowerCase)` makes the new test fail
  with `expected 0.25 to be 0` — exactly the spurious-confidence
  symptom (1 of 4 keywords matched the empty-string blank ⇒
  confidence inflated to 0.25 against a completely unrelated
  input).
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1048
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. The matcher is pure-function dispatch arithmetic,
  not HTTP surface.

## Status

Done. The rule-based matcher's confidence is now load-bearing:

| Keyword list                          | Input                                  | Before          | After          |
| ------------------------------------- | -------------------------------------- | --------------- | -------------- |
| `["calendar", ""]`                    | unrelated text                         | **0.5** (false) | 0 (**fixed**)  |
| `["calendar", "", "  ", "schedule"]`  | unrelated text                         | **0.25** (false)| 0 (**fixed**)  |
| `["calendar", ""]`                    | text with "calendar"                   | 1.0             | 1.0            |
| `["calendar"]`                        | unrelated text                         | 0               | unchanged      |
| `["calendar"]`                        | text with "calendar"                   | 1.0             | unchanged      |
| `[]`                                  | any text                               | 0               | unchanged      |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
input-cleanup `fix:` on the multi-agent dispatch matcher,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **Filter at construction, not at the matcher.** Cleanup once
  at construction; `canHandle` then runs the same way on every
  call without paying the filter cost per dispatch. Matches
  the way the existing `toLowerCase` is applied (cheap, one-
  time normalisation at construction).
- **`.trim()` BEFORE the empty-check**, not just `length > 0`
  on the raw value. A keyword of `"  "` (two spaces) survives
  a bare `length > 0` check, then `text.includes("  ")`
  matches any double-space in the input — still a false-positive
  hazard, just rarer than the universal `""` case. Trimming
  catches both shapes.
- **Silent filter, not throw.** Matches the codebase's "be
  liberal in what you accept" pattern for caller-supplied
  config (CSV splits, env parsing, etc.). Throwing would be
  louder but would force every caller to pre-clean their
  keyword arrays. The supervisor's fallback path
  (`defaultWorkerId`) handles the "no keywords" worker
  gracefully (returns 0 confidence, supervisor routes
  elsewhere).
- **Mutation choice.** Reverted exactly the two-line filter
  back to the bare `map(toLowerCase)`. The mutation reproduces
  the pre-fix shape — a maintainer "simplifying back to a
  one-line normalisation" would land exactly that diff. The
  mutation test catches it with the exact 0.25 spurious-
  confidence symptom.
- **Test placement at the TOP of the SupervisorAgent describe**
  rather than at the end. The test pins a defensive
  precondition of every subsequent test — they all use
  `RuleBasedAgentWorker` with non-blank keyword lists; this
  test pins the contract those rely on.
- **Asserted the partial-match (0.5) and full-match (1.0) cases**
  alongside the unrelated (0) case. Pinning all three positions
  on the confidence scale means a future regression that
  over-filters (e.g. dropping ALL keywords) would also be
  caught by the partial / full assertions.

## Remaining risks

- **`keywords: [""]`** — a list that's ONLY blank entries —
  ends up with `this.keywords = []`. `canHandle` then returns
  0 (the `keywords.length === 0 ? 0 : matched / length`
  branch). The worker is effectively no-match; supervisor
  falls back to `defaultWorkerId`. Same behaviour as
  intentionally constructing with `keywords: []` — consistent.
- **Duplicate keywords** (`["calendar", "calendar"]`) aren't
  deduped here. `text.includes("calendar")` returning true
  scores `matched = 2`, confidence = 2/2 = 1.0 — same answer
  a deduped `["calendar"]` would produce, so functionally
  equivalent. Cosmetic at most.
- **Substring confusion** (`"cal"` matches `"calendar"` AND
  `"calcium"`) is by design — the matcher is documented as
  substring-based, not whole-word. Operators choosing
  keywords own the false-positive risk.
- **`joinMessages`** concatenates message contents with
  newlines — a malicious / scripted system message could
  prepend keywords to bump an unrelated worker's
  confidence. Same trust gradient applies; out of scope.
