# 516 — `LocalDirNotesProvider.search` snippet drops a lone trailing high surrogate (goal-451/499/500/501 sibling on the notes search-result render path)

## Why

`packages/mcp/src/notes-providers-local.ts:176` truncated the
search-result `snippet` field with a bare UTF-16 slice:

```ts
snippet: line.length > 240 ? `${line.slice(0, 240)}...` : line,
```

`String.prototype.slice` cuts on UTF-16 code units. An astral
character (emoji, CJK extension, math symbol) is **two**
UTF-16 units — a high surrogate (0xD800-0xDBFF) followed by a
low surrogate (0xDC00-0xDFFF). If `line.slice(0, 240)` cuts
between those two halves, the result ends in a lone high
surrogate, which is **invalid UTF-16** (and invalid UTF-8 when
re-encoded for any JSON / SSE / network consumer).

Concretely: a note line like `"needle <232 'x's>😀rest"` has
the emoji's high surrogate at code-unit index 239 and the low
surrogate at index 240. `slice(0, 240)` keeps the high
surrogate and discards the low surrogate — the snippet
returned to the consumer ends with an orphaned `\uD83D` which:

- JSON.stringify is permissive and will emit it as
  `"\uD83D"`, but
- downstream JSON re-parsers can crash
  (`SyntaxError: Unexpected end of input`),
- terminals print it as `?` or a replacement glyph,
- LLM context windows that re-tokenise the snippet may
  truncate, and
- log aggregators that re-encode as strict UTF-8 (Slack /
  Discord / Telegram forwards) silently drop or 400 the
  message.

Same surrogate-cap defect class as goals 451 / 499 / 500 /
501. The convention has landed on the messaging response
filter (451), agent-core max-length filter (499), the
followup summariser (500), and user-memory store (501). The
notes search-result snippet was the remaining outlier on the
notes-search-result wire path — the snippet flows into every
`@muse/mcp` notes-loopback response and every `muse notes
search` CLI render.

## Slice

- `packages/mcp/src/notes-providers-local.ts` — extracted a
  pure exported helper `sliceWithoutLoneSurrogate(value,
  cap)` at the bottom of the file:
  ```ts
  export function sliceWithoutLoneSurrogate(value: string, cap: number): string {
    const head = value.slice(0, cap);
    if (head.length === 0) return head;
    const last = head.charCodeAt(head.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
  }
  ```
  Wired into the snippet truncation:
  ```ts
  snippet: line.length > 240
    ? `${sliceWithoutLoneSurrogate(line, 240)}...`
    : line,
  ```
  Behaviour byte-identical for every line that does NOT have a
  surrogate pair straddling index 239/240 — only the boundary-
  cut path is closed.
- `packages/mcp/test/notes-snippet-surrogate-cap.test.ts` —
  new file, 6 focused tests:
  - 5 tests on the helper (BMP boundary cut, cap ≥ length,
    mid-pair-cut drops the orphan, complete pair preserved,
    empty input)
  - 1 integration test exercising the actual
    `LocalDirNotesProvider.search` snippet path: writes a
    note with an emoji at code-unit index 239, asserts the
    returned snippet contains NO lone surrogate at any index

## Verify

- New test 6/6 green; full `@muse/mcp` suite green (523
  passed, +6 vs baseline 517, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the call
  site back to a bare `line.slice(0, 240)` makes the
  integration test fail with the precise pre-fix symptom —
  `snippet index 239 must not be a lone surrogate: expected
  true to be false`. The helper-direct tests stay green
  (they exercise the helper, not the call site). Fix
  restored, suite back to 6 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure UTF-16 cap helper — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the notes-
  search-result snippet returned through the MCP notes-
  loopback response, not the model loop.

## Status

Done. A note line with an emoji at the 240-char boundary no
longer produces a search-result snippet ending in a lone high
surrogate. The cross-package surrogate-cap convention now
covers five sibling sites — messaging response filter,
agent-core max-length filter, followup summariser, user-memory
store, and notes search-result snippet — with the same
0xD800-0xDBFF trailing-unit check at each cut.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry
robustness `fix:` on the notes search-result wire path,
recorded honestly with this backlog row — not a false
metric.

## Decisions

- Step-8 redirect from the strict-parse run (513 / 514 / 515)
  to a different defect class (surrogate-cap) on a different
  surface (MCP notes loopback). Productive sibling pivot,
  not same-area churn.
- Extracted the helper to the file rather than a shared
  package: the cross-package convention has been to inline
  the check (see goals 499 / 500 / 501 / `truncateErrorBody`
  in `@muse/shared`). Extracting and re-using a 4-line
  helper across packages would invite re-implementing the
  check at each new call site anyway — the inline pattern is
  already documented in the `truncateErrorBody` comment. The
  one-file-local extraction keeps the call site readable
  while still being testable directly. Future callers in
  this same file can reuse it.
- Used `0xd800 <= last <= 0xdbff` (high surrogate range)
  rather than checking the more general `(0xd800..0xdfff)`
  range: a lone low surrogate (0xdc00..0xdfff) at the end
  would already need a high surrogate before it, which `slice`
  can't produce on its own. The narrower check matches the
  convention from `truncateErrorBody` (`@muse/shared`) and the
  agent-core / memory / messaging cap helpers byte-for-byte.
- Tested the integration path through the public `search`
  API rather than re-rigging an internal helper: the surrogate
  cap is meaningful only when the snippet survives the
  consumer wire, so the test exercises that wire end-to-end
  (writes a file, runs `provider.search`, inspects the
  returned `snippet`). Mirrors the goal-501 user-memory
  integration test shape.
