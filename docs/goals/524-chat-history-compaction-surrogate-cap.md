# 524 — `maybeCompactLastChatHistory` summary text caps each turn's content surrogate-safely (goal-451/499/500/501/516 sibling on the chat-history compaction pre-LLM prompt)

## Why

`apps/cli/src/chat-history.ts:247` capped each older-turn's
content at 400 UTF-16 units with a bare `slice` before stitching
into the LLM summary prompt:

```ts
const content = (parsed.content ?? "").slice(0, 400);
return `${role}: ${content}`;
```

`String.prototype.slice` cuts on UTF-16 code units. An astral
character (emoji, math symbol, CJK extension) is two UTF-16
units — high surrogate (0xD800–0xDBFF) followed by low
surrogate (0xDC00–0xDFFF). If a turn's `content` happens to
have an emoji whose high surrogate sits at index 399 and low
surrogate at 400, `slice(0, 400)` keeps the high surrogate and
discards the low surrogate — the prompt sent to the LLM
contains a lone trailing high surrogate at index 399 of that
turn.

The downstream consumer is the LLM compaction call's
`messages: [{role: "user", content: olderText}]`. Most
provider tokenisers handle invalid UTF-16 gracefully (replace
or skip), but:

- some tokenisers crash or refuse the request;
- HTTP transport that re-encodes through strict UTF-8 (Ollama's
  WebSocket fallback, some OpenAI-compatible servers) silently
  drops the orphaned byte and produces a different prompt than
  intended;
- the JSON payload the prompt is wrapped in (`JSON.stringify({
  messages: [...] })`) emits `"\uD83D"` literals that downstream
  re-parsers can reject as invalid UTF-16.

Same surrogate-cap defect class as goals 451 / 499 / 500 / 501
/ 516. The convention has landed on the messaging response
filter (451), agent-core max-length filter (499), followup
summariser (500), user-memory store (501), and notes search-
result snippet (516). The chat-history compaction summary was
the remaining outlier — and arguably the highest-trip-count
site, since EVERY compaction at REPL boot runs this slice on
each older turn.

## Slice

- `apps/cli/src/chat-history.ts` — extracted a tiny pure
  exported helper `capContentForSummary(value, cap)`:
  ```ts
  export function capContentForSummary(value: string, cap: number): string {
    const head = value.slice(0, cap);
    if (head.length === 0) return head;
    const last = head.charCodeAt(head.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
  }
  ```
  Wired into the compaction loop:
  ```ts
  const content = capContentForSummary(parsed.content ?? "", 400);
  ```
  Behaviour byte-identical for every turn whose 400th UTF-16
  unit is NOT a low surrogate. Only the boundary-cut-mid-pair
  path now drops the orphaned high surrogate.
- `apps/cli/src/chat-history.test.ts` — new file, 5 focused
  tests on the helper:
  - clean BMP boundary cut returns the slice unchanged
  - cap ≥ length returns input unchanged
  - boundary cut mid-pair drops the high surrogate (the
    defect this iteration closes)
  - complete surrogate-pair cut preserved
  - empty input

## Verify

- New test 5/5 green; full `@muse/cli` suite green (884
  passed, +5 vs baseline 879, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the helper
  back to a bare `return value.slice(0, cap);` makes the
  boundary-cut test fail with the precise pre-fix symptom —
  `expected 'xxx…<orphan high surrogate>' to be
  'xxx…'` (the slice keeps the lone high surrogate). Every
  other test stays green. Fix restored, suite back to 5
  green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure UTF-16 cap helper — no LLM request-response wire path
  change in observable behaviour for clean content; the
  defended path is the **prompt-construction** boundary
  immediately before the model call. `smoke:live` does not
  apply (per `testing.md` / iteration-loop Step 9).

## Status

Done. A chat turn whose content has an emoji at code-unit
index 399 no longer produces a compaction-summary prompt with
a lone trailing high surrogate. The cross-package surrogate-
cap convention now covers six sibling sites: messaging
response filter (451), agent-core max-length filter (499),
followup summariser (500), user-memory store (501), notes
search-result snippet (516), and chat-history compaction
summary (this goal). Each fallback is "drop the orphan", the
same shape at every site.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry robustness
`fix:` on the chat-history compaction summary, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the finite-Date guard run (522 / 523)
  on `@muse/auth` to the surrogate-cap defect class on
  `@muse/cli`. Different defect class, different package —
  productive variation that closes a class outlier rather
  than churning the same area.
- Extracted the helper to the same file rather than to
  `@muse/shared` or any cross-package helper: the
  cross-package convention has been to inline the check (see
  goals 499 / 500 / 501) or extract a single-package helper
  (goal 516's `sliceWithoutLoneSurrogate`). A `@muse/shared`
  helper would invite cross-package coupling for a 4-line
  check that's easy to read inline. Future callers in
  `chat-history.ts` can reuse the helper.
- Returned the cap-unchanged when `head.length === 0`: the
  `cap = 0` or empty input paths are valid and shouldn't crash
  on a `charCodeAt(-1)` lookup.
- The mutation reverts the helper body (one short statement)
  rather than the call site — the call site change is byte-
  identical to the pre-fix code's call-site shape, so the
  test should exercise the helper directly. This matches
  goal 516's mutation choice.
- The `apps/cli/src/chat-history.test.ts` is a new file
  because no co-located test existed; the legacy program-
  test fixture covers `maybeCompactLastChatHistory` end-to-
  end for goal 138 but doesn't exercise the surrogate
  boundary. A new dedicated file is cleaner than threading
  surrogate cases into the already-large goal-138 test.
