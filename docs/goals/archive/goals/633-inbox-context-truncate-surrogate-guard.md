# 633 — `renderInboxSection`'s `truncate` drops an orphaned high surrogate when the 200-char preview cut lands inside a UTF-16 surrogate pair, so an attacker-controllable inbound message (Slack/Discord/Telegram) with an emoji at exactly position 199 doesn't leave a lone `0xD83D` in the rendered `[Recent Messages]` block

## Why

`packages/agent-core/src/inbox-context.ts:truncate` is the
per-message preview-clip that runs on every inbound message
surfaced into the `[Recent Messages]` system-prompt block.
Pre-fix:

```ts
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
```

`String.prototype.slice` operates on UTF-16 **code units**, not
Unicode code points. An astral-plane character (emoji like 📋,
math symbols, supplementary CJK ideographs) is stored as two
16-bit surrogate code units in JS strings. When the cut at
`slice(0, max - 1)` lands BETWEEN the high (0xD83D-0xDBFF) and
low (0xDC00-0xDFFF) surrogates of a single code point, the head
ends with a **lone high surrogate** — invalid UTF-16.

Concrete attack-shaped case: with the default
`DEFAULT_TEXT_PREVIEW = 200`, an inbound message
`"a".repeat(198) + "📋" + ...` has its emoji's high surrogate at
code-unit index 198 and low surrogate at index 199. The cut
`slice(0, 199)` keeps the high surrogate at index 198 and drops
the low surrogate at index 199. The head is now 199 code units
ending in `0xD83D`. The downstream impact:

- **JSON encoding** (the system prompt → model wire is JSON):
  `JSON.stringify` replaces the lone surrogate with U+FFFD
  (REPLACEMENT CHARACTER) on the wire. The model sees `?` or
  `�` instead of the partial emoji.
- **Terminal output** (`muse status`, `muse inbox` render the
  same block): the terminal's UTF-8 decoder rejects lone
  surrogates; rendering varies (replacement char, raw bytes, or
  control sequences leaking).
- **Persistence** (`~/.muse/last-chat.jsonl`, debug captures):
  the JSONL line carries the malformed string, and round-trip
  reload may further mangle it.

Inbound message text is attacker-controllable — any Slack /
Discord / Telegram user can send a message engineered to put an
emoji at exactly position 199. The fix is the same one already
established in three sibling sites:

| Site                                              | Has surrogate guard? |
| ------------------------------------------------- | -------------------- |
| `packages/shared/src/index.ts:truncateErrorBody`  | yes                  |
| `packages/agent-core/src/response-filters.ts:createMaxLengthResponseFilter` | yes |
| `packages/messaging/src/provider-helpers.ts:clampOutboundText` | yes (via `dropTrailingLoneHighSurrogate`) |
| **`packages/agent-core/src/inbox-context.ts:truncate`** | **NO**          |
| `packages/agent-core/src/episodic-recall.ts` (inline `slice`) | NO          |
| `packages/agent-core/src/skills-context.ts:truncate` | NO                |
| `packages/agent-core/src/ambient-context.ts` (inline) | NO                |
| `packages/agent-core/src/attachment-context.ts` (inline) | NO              |

`inbox-context.ts` is the most attacker-reachable of the
unguarded sites: the input is third-party-controlled inbound
text, not internal agent state. Picked as the highest-impact
single site for this iter. Four other agent-core sibling sites
remain (epicodic-recall / skills-context / ambient-context /
attachment-context) — each is its own iter, all carry the same
defect class but with operator-controlled input rather than
attacker-controlled.

This iter's defect class — **UTF-16 surrogate-pair boundary in
`slice`-based truncation: lone high surrogate leaks into JSON
wire / terminal output** — is fresh against the recent window:

- 632: tilde-expansion in env-path resolver
- 631: concurrent-write serialization
- 630: mkdtemp directory cleanup
- 629: per-entry validation
- 628: unit-promotion + finite-guard
- 627: tolerant-read nested array
- 626: child-process stream error
- 625: strict env-parse
- 624: HTTP timeout
- 623: classification

Multi-byte / surrogate-pair encoding hazards haven't been hit
in any recent iter; the closest sibling is the established
fix in `clampOutboundText` (`packages/messaging`), but that was
inherited from earlier work.

## Slice

- `packages/agent-core/src/inbox-context.ts:truncate`:
  - Read the last code unit of the slice via
    `head.charCodeAt(head.length - 1)`.
  - If it's in the high-surrogate range (`0xD800` to `0xDBFF`),
    `head = head.slice(0, -1)` drops the orphan before the
    ellipsis is appended.
  - Exact same pattern as `response-filters.ts:80-83` and
    `shared/src/index.ts:192-195`.
  - The function signature and the well-formed-input behavior
    are unchanged — only the surrogate-cut case differs.
- `packages/agent-core/test/inbox-context.test.ts`:
  - One new test in the existing `renderInboxSection` describe
    block:
    - Build an inbound message `"a".repeat(198) + "📋" +
      "x".repeat(200)`. The emoji's high surrogate sits at
      code-unit index 198 (inside the cut) and low surrogate
      at 199 (just past the cut).
    - Assert `marker.length === 2` first (pins the encoding
      assumption — 📋 = `U+1F4CB` = 0xD83D 0xDCCB in UTF-16).
    - `renderInboxSection(snapshot)` runs the whole render
      pipeline including the truncate.
    - Assert no lone high surrogate via the regex
      `[\uD800-\uDBFF](?![\uDC00-\uDFFF])` — same pattern
      `provider-helpers.test.ts` uses.
    - Assert `rendered.includes("\uD83D") === false` — the
      orphaned half of 📋 specifically.

## Verify

- `@muse/agent-core` suite green (662 passed, +1 vs the
  pre-iter baseline of 661, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the head
  slice+chmod to the bare `text.slice(0, max - 1)` makes the
  new test fail with `expected true to be false` — the regex
  matches a lone high surrogate in the rendered output. The
  pre-existing "truncates very long messages" test still
  passes because its input is pure ASCII (no surrogates). Fix
  restored, all 662 tests green.
- One iteration cycle was needed to correct the test
  positioning: the first draft used `198 + 199 = ...` math
  that placed the emoji ENTIRELY past the cut point, so the
  pre-fix branch never triggered. Recomputing the indices
  (high surrogate at index 198, cut at index 199) put one
  surrogate inside and one outside the slice — the actual
  defect surface. The corrected test exposes the bug.
- `pnpm check` green: apps/api 261/261, apps/cli 1093/1093,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean
  on both touched files.
- No LLM request/response wire path touched in code — but the
  RENDERED prompt block IS what reaches the model. The fix
  silently improves wire correctness; no behavioral change
  for healthy inputs. `smoke:live` doesn't apply (the test
  surface is the unit test).

## Status

Done. The 200-char preview cut in `renderInboxSection` now
preserves UTF-16 well-formedness across every emoji /
supplementary-plane char that lands at the boundary:

| Emoji code-unit position (relative to 200-char cut) | Before              | After                |
| --------------------------------------------------- | ------------------- | -------------------- |
| Before the cut (e.g. position 50)                   | unchanged           | unchanged            |
| **High surrogate at 198, low at 199**               | **lone 0xD83D leaks** | orphan dropped (**fixed**) |
| Both surrogates after the cut (position 199-200)    | unchanged           | unchanged            |
| ASCII-only text                                     | unchanged           | unchanged            |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
/ encoding-correctness `fix:` on the inbox prompt-injection
surface. Recorded honestly with this backlog row.

## Decisions

- **Inline guard instead of a shared helper.** Three sibling
  sites already inline the same 3-line pattern
  (`response-filters.ts`, `shared/src:truncateErrorBody`,
  `messaging/src/provider-helpers.ts:dropTrailingLoneHighSurrogate`).
  Extracting a fourth shared helper would touch 3-5 files for
  one missed site. The inline guard keeps scope tight; a later
  consolidation iter can extract the helper across all 5
  agent-core sites at once.
- **Only `inbox-context.ts` this iter.** Four other agent-core
  sites have the same defect (`episodic-recall.ts:86`,
  `skills-context.ts:90`, `ambient-context.ts:45`,
  `attachment-context.ts:135`) — each is operator/store-
  controlled rather than attacker-controlled, so the
  reachability is lower. Picked the attacker-reachable site
  first.
- **Test asserts NO lone high surrogate via regex** rather
  than checking the exact character count. The regex
  `[\uD800-\uDBFF](?![\uDC00-\uDFFF])` is the standard
  "isolated high surrogate" pattern used by
  `provider-helpers.test.ts:40` and other JSON-wire-safety
  checks. The same regex catches future regressions (e.g. if
  someone introduces a different code path that produces lone
  surrogates).
- **First test draft was incorrect** — used `"a".repeat(199)`
  which put the emoji entirely past the cut point. Caught by
  mutation: the test passed pre-fix because no surrogate was
  in the slice's last position. Recomputed: high surrogate at
  index 198 + cut at 199 means slice keeps high (index 198) and
  drops low (index 199). Used `"a".repeat(198)` and re-ran.
  Documenting here because it's the kind of off-by-one that's
  easy to recreate and worth pinning the positioning math.
- **Asserted `marker.length === 2`** as a sanity check on the
  encoding assumption. If a future TS version or Node version
  changes how `"📋".length` reports (it shouldn't — it's
  spec-defined UTF-16), the test fails loudly instead of
  silently mis-positioning the boundary.
- **Did NOT add a defensive `if (head.length === 0)` after
  the surrogate drop.** If `max === 1`, `text.slice(0, 0)`
  returns `""`, the surrogate check on `""` reads `charCodeAt
  (-1) === NaN`, which fails the `>= 0xd800` check, so the
  function returns `"…"`. Healthy fall-through.
- **Mutation choice.** Reverted the whole 4-line block back to
  the bare `${text.slice(0, max - 1)}…`. One test fails with
  the exact surrogate-detection regex assertion. The other 16
  pre-existing tests in the file pass pre- and post-fix
  because they don't touch surrogate-pair boundaries.

## Remaining risks

- **Four other agent-core sites still carry the defect**
  (`episodic-recall.ts:86`, `skills-context.ts:90`,
  `ambient-context.ts:45`, `attachment-context.ts:135`). Each
  is operator/store-controlled (skill manifests, ambient
  signals, attachment summaries) rather than attacker-
  controlled, but the same byte-level corruption can still
  reach the prompt / terminal. Sweep iter would touch all 4
  at once, possibly via a shared helper extraction.
- **Low surrogate at the START of the slice's tail** is not
  guarded — if someone uses `slice(N, M)` (not just `slice(0,
  N)`) and the START lands inside a pair, the result begins
  with a lone low surrogate. None of the touched sites use
  that pattern; out-of-scope.
- **Combining characters** (a base char + a combining mark)
  can also be split by `slice` — the base char is preserved
  but the combining mark is lost. The fix doesn't address
  this; combining marks are valid UTF-16 individually and
  don't trigger the lone-surrogate check. Less common in
  attacker-controlled text than emoji.
- **ZWJ sequences** (👨U+200D👩U+200D👧 = 5-7 code units joined by zero-
  width joiners) can be split at a non-pair boundary, leaving
  a partial emoji that renders differently (e.g. just 👨 +
  ZWJ). The truncation is still well-formed UTF-16; only the
  semantic emoji is fragmented. Acceptable for a 200-char
  preview.
