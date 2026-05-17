# 306 — topic-drift matched keywords as raw substrings (short ASCII keyword bypass)

## Why

`detectTopicDrift` (`@muse/policy`) keeps a conversation on-task
— it scores a prompt against the configured topics' keywords and
allows / blocks based on the overlap fraction. `scoreTopic` used
`normalizedText.includes(keyword)`: a **raw substring** match.
Short or common ASCII keywords (`ai`, `go`, `db`, `rag`) then
match inside unrelated words — `ai` in `email`/`again`, `rag` in
`storage`/`garage` — so a fully off-topic prompt scores on-topic,
`allowed: true`, and the drift guard is **silently defeated**.
Same false-positive class as the wake-word fix (goal 270) and
`message-importance`'s min-length hint guard.

The naive "require whole-word" fix would **regress the primary
user language**: the existing Korean test matches `우선순위`
inside `우선순위를` — Korean agglutinates particles without
spaces, so a stem legitimately appears as a substring of a larger
token. Word-boundary matching must therefore be ASCII-only, with
CJK keeping substring — the exact split `episodic-recall`'s
tokeniser already uses.

## Scope

`packages/policy/src/topic-drift.ts`:

- Replace the `includes` keyword test (in both `scoreTopic` and
  the off-topic-allowance `matchesAnyKeyword`) with
  `containsKeyword(haystack, keyword)`:
  - keyword contains a CJK char (Hangul / CJK ideograph /
    Hiragana / Katakana) → `haystack.includes(keyword)`
    (substring — correct for agglutinative Korean/Japanese);
  - otherwise (ASCII/Latin/digits) → require a word boundary:
    `(?:^|[^a-z0-9])<escaped>(?:$|[^a-z0-9])` (regex-escaped),
    so the keyword can't fire inside a larger alnum run.
  One short WHY comment records the ASCII-vs-CJK rationale; a
  local `hasCjkChar` (same ranges as `episodic-recall`, no
  cross-package import) does the split.

Behaviour-preserving for genuine keyword usage (whole-word ASCII
matches, CJK substring matches); only ASCII substrings embedded
in unrelated words — previously a guard bypass — stop counting.

## Verify

- `pnpm --filter @muse/policy test` — 66 pass (was 64; +2). New:
  topics `["ai","rag"]` vs "please email my friend again about
  the storage garage" → `allowed: false` (pre-fix: `true`,
  score 1 — guard defeated); "the AI uses RAG retrieval" still
  `allowed: true` with both keywords matched; Korean
  `우선순위` still matches inside `우선순위를`. The existing
  English-overlap / drift-block / Korean-tokens-and-off-topic
  tests stay green (test 3's `우선순위`-in-`우선순위를` confirms
  the CJK path is preserved).
- `pnpm check` — every workspace green (policy 66, apps/cli 563,
  apps/api 161, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (deterministic guard
  over input text). A live Qwen run cannot reproduce a
  short-keyword substring bypass on demand, so the deterministic
  regression is the rigorous verification — same stance as the
  wake-word goal 270 and the security guards.

## Status

done — topic-drift now matches ASCII keywords on word boundaries
while keeping CJK substring matching, so a short keyword can no
longer silently fire inside unrelated English words and defeat
the on-task guard, and Korean stem matching (the primary user
language) is unchanged.
