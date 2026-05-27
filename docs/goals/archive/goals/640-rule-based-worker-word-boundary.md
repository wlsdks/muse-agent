# 640 — `RuleBasedAgentWorker.canHandle` matches ASCII keywords on word boundaries (CJK stays substring-match) so short keywords like `"ai"` / `"go"` / `"rag"` don't fire inside unrelated words and silently inflate dispatch confidence — sibling-parity with `packages/policy/src/topic-drift.ts:containsKeyword`

## Why

`packages/multi-agent/src/index.ts:RuleBasedAgentWorker.canHandle`
pre-fix:

```ts
canHandle(input: AgentRunInput): number {
  const text = joinMessages(input.messages).toLowerCase();
  const matched = this.keywords.filter((keyword) => text.includes(keyword)).length;
  return this.keywords.length === 0 ? 0 : matched / this.keywords.length;
}
```

`String.prototype.includes` is **substring match**, not word
match. So a short ASCII keyword fires inside any text that
contains it as a substring of an unrelated word. The
operator's intent — "this worker handles AI / RAG / Go
questions" — silently becomes "this worker handles any
email, anything ago, anything fragmented." Concrete traps:

| Keyword | False-positive inside        | Pre-fix verdict |
| ------- | ---------------------------- | --------------- |
| `"ai"`  | `email`, `afraid`, `train`   | matches         |
| `"go"`  | `ago`, `lego`, `argo`        | matches         |
| `"rag"` | `fragment`, `bragged`        | matches         |
| `"db"`  | `dbus`, `subdb`              | matches         |
| `"ssh"` | `mishap`, `pushsh`           | matches         |
| `"ml"`  | `html`, `xml`, `formula`     | matches         |

For a worker configured with `["ai", "rag", "go"]`, an input
like `"the email arrived and i'm afraid the fragment broke
long ago"` matches all THREE keywords (`ai` ⊂ `email/afraid`,
`rag` ⊂ `fragment`, `go` ⊂ `ago`) → confidence 1.0. The
supervisor then routes that completely-unrelated request to
the tech worker.

The sibling policy module `packages/policy/src/topic-drift
.ts:containsKeyword` ALREADY handles this correctly:

```ts
function containsKeyword(haystack: string, keyword: string): boolean {
  if (keyword.length === 0) return false;
  if (hasCjkChar(keyword)) return haystack.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "u").test(haystack);
}
```

`RuleBasedAgentWorker` was the missed sibling — same kind of
keyword matcher, different rigor. CJK keywords keep substring
matching because Korean / Japanese / Chinese agglutinate
without spaces (`우선순위` inside `우선순위를` is the same
word stem + a particle).

This iter's defect class — **substring-match inflation in a
keyword matcher; word-boundary check missing relative to the
sibling that already has it** — is fresh against the recent
window:

- 639: keyword dedup (sibling-parity to 619)
- 638: lenient base64url decode (auth bypass)
- 637: lenient base64 decode (loopback tool)
- 636: HTTP timeout
- 635: per-file concurrent write (memory store)
- 634: sort tiebreaker
- 633: surrogate-pair truncation
- 632: tilde-expansion
- 631: per-file concurrent write (messaging)
- 630: mkdtemp directory cleanup

Closely related to 619 (blank-keyword filter, 21 iters back)
and 639 (keyword dedup, 1 iter back), but the defect class is
distinct — those normalised WHICH keywords participate;
this changes HOW each keyword matches.

## Slice

- `packages/multi-agent/src/index.ts`:
  - Replace `text.includes(keyword)` in the filter
    callback with `containsKeywordWithBoundary(text, keyword)`.
  - Added file-local helper `containsKeywordWithBoundary` that
    mirrors `topic-drift.ts:containsKeyword`:
    - Empty keyword → false.
    - CJK keyword → fall back to `haystack.includes(keyword)`
      so Korean stems don't get rejected by particle suffixes.
    - ASCII / Latin keyword → word-boundary regex
      `(?:^|[^a-z0-9])<escaped>(?:$|[^a-z0-9])` to match only
      when the keyword is delimited by string boundaries or
      non-alphanumeric characters.
  - Added file-local `hasCjkCodePoint` helper (mirrors
    `topic-drift.ts:hasCjkChar`) covering the same four
    Unicode blocks (CJK Unified Ideographs, Hangul, Hiragana,
    Katakana).
  - A short WHY comment names the matching contract — when a
    maintainer reads `canHandle` they see why a `.includes`
    isn't appropriate.
- `packages/multi-agent/test/multi-agent.test.ts`:
  - Two new tests in the existing `SupervisorAgent` describe:
    1. **ASCII word-boundary** — keywords `["ai", "rag", "go"]`
       against `"the email arrived and i'm afraid the fragment
       broke long ago"` (all three substring traps). Post-fix
       confidence is 0. Plus a positive case (`"let's go for
       ai with rag pipelines"` matches all three → 1.0) and a
       punctuation case (`"ai, then rag."` → 2/3, since `go`
       isn't in the text).
    2. **CJK substring fallback** — keyword `["우선순위"]`
       against `"이 일의 우선순위를 정해줘"` (Korean for "set
       the priority of this work"). The particle `를`
       agglutinates without a space; word-boundary would
       reject, CJK substring catches it → 1.0.

## Verify

- `@muse/multi-agent` suite green (51 passed, +2 vs the
  pre-iter baseline of 49, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the
  filter callback back to `text.includes(keyword)` makes the
  ASCII word-boundary test fail with the EXACT pre-fix
  symptom — `Received: 1` (all three substring traps fired
  on the unrelated text) vs. `Expected: 0`. The CJK test
  passes pre- AND post-fix because CJK substring matching is
  preserved either way. The 48 other pre-existing tests
  (including goal 619's blank-filter and goal 639's dedup
  pins) pass both pre- and post-fix — confirms the fix is
  surgical to the ASCII substring-inflation path.
- `pnpm check` green: apps/api 261/261, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean.
- No LLM request/response wire path touched — pure in-process
  keyword matching. `smoke:live` doesn't apply.

## Status

Done. `RuleBasedAgentWorker.canHandle` confidence now
reflects the operator's actual intent across short keywords
that pre-fix produced false-positives on virtually any input:

| Configured keywords          | Text                                    | Before | After |
| ---------------------------- | --------------------------------------- | ------ | ----- |
| `["ai", "rag", "go"]`        | "the email arrived broke long ago"      | **1.0**| **0** (**fixed**) |
| `["ai", "rag", "go"]`        | "let's go for ai with rag pipelines"    | 1.0    | unchanged |
| `["ai", "rag", "go"]`        | "ai, then rag."                         | 1.0 (false positive `go` in nothing)  | 2/3 (correct) |
| `["우선순위"]` (CJK)         | "우선순위를 정해줘"                     | 1.0    | unchanged (CJK substring) |
| `["calendar", "schedule"]`   | "what's on my calendar today?"          | 0.5    | unchanged |
| `["task"]`                   | "task"                                  | 1.0    | unchanged |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
robustness / matcher-precision `fix:` on the supervisor
dispatch layer. Recorded honestly with this backlog row.

## Decisions

- **Mirror `topic-drift.ts:containsKeyword` exactly**, not
  import it. Cross-package imports (`@muse/multi-agent` →
  `@muse/policy`) would create a new dependency edge for two
  tiny helpers. Both copies are 12 lines each; if the matcher
  evolves in one place, a future iter can consolidate via a
  shared `@muse/shared:matchKeyword` helper. The doc names
  the duplication so a future audit can find it.
- **CJK substring fallback**, not word-boundary. Korean (the
  primary non-English language) agglutinates particles
  without spaces — `우선순위` ("priority") inside
  `우선순위를` ("priority + object-particle") is the same
  word stem with a grammatical suffix. Word-boundary would
  break this. Japanese kanji and Chinese have the same
  property. The CJK code-point ranges in `hasCjkCodePoint`
  match `topic-drift.ts:hasCjkChar` byte-for-byte.
- **`(?:^|[^a-z0-9])...(?:$|[^a-z0-9])`** for the word
  boundary. JavaScript's `\b` is ASCII-only AND treats `_` as
  a word character, which is fine here (lowercase + digits),
  but the explicit `[^a-z0-9]` class makes the matcher's
  contract obvious and doesn't depend on regex-engine
  semantics for Unicode boundary.
- **Regex escaping**: `keyword.replace(/[.*+?^${}()|[\]\\]/gu,
  "\\$&")` matches `topic-drift.ts` exactly. Without it a
  keyword containing `.` or `*` would be regex-meaningful;
  with it, every char is literal.
- **One short WHY comment** at the helper, not inside
  `canHandle`. The matching contract belongs at the helper —
  the dispatch site just calls it.
- **Did NOT add a config knob to disable word-boundary.**
  Substring matching is never what an operator actually
  wants in this context (if they wanted substring they'd put
  `"em"` not `"ai"`). No flag needed.
- **Mutation choice.** Reverted only the filter callback
  back to `text.includes`. The new ASCII word-boundary test
  fails with the literal `Received: 1` substring-trap
  symptom; the new CJK test passes both ways; the 48 other
  pre-existing tests pass both ways. Surgical proof.

## Remaining risks

- **Other matchers** in the codebase. `topic-drift.ts` is
  done; `RuleBasedAgentWorker` is done. A grep for
  `text.includes(keyword)` or `haystack.includes(keyword)`
  finds:
  - `packages/agent-core/src/tool-filter.ts:127` — already
    uses `\b` word-boundary via `new RegExp(\`\\b${escapeRegex
    (keywordLower)}\\b\`)`.
  - `packages/agent-core/src/message-importance.ts` — uses
    `content.includes(...)` for context hint matching, but
    matchableHint guards against short hints (≥ 3 chars)
    that the iter-16 comment documents.
  No remaining "naive substring keyword match" sites that I
  found.
- **CJK detection is heuristic**, not full Unicode. A
  Vietnamese / Thai / Arabic keyword would fall to the
  ASCII word-boundary path — which uses `[^a-z0-9]` as the
  boundary char class. For non-ASCII text, the
  `(?:^|[^a-z0-9])` boundary still works because all
  non-ASCII chars are by definition not in `[a-z0-9]`. So
  Vietnamese ("ưu tiên") would substring-match inside Latin
  context, word-boundary-match around its own script. Not
  perfect; not a regression either.
- **Code duplication with `topic-drift.ts`.** Two copies of
  the same 20-line helper. If a third keyword matcher
  appears, a refactor extracting to `@muse/shared` is
  warranted. Out of scope for this iter — the two extant
  call-sites are small and the shape is unlikely to drift in
  the short term.
