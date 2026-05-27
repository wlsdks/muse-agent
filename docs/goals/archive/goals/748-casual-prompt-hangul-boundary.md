# 748 — fix: Korean greetings never detected as casual (`\b` after Hangul never matches)

## Why

`isCasualPromptText` (response-filters-verified-sources) decides
whether a user prompt is casual chit-chat (a greeting / thanks) so the
verified-sources response filter does NOT staple a `[Sources]` block
onto a reply to "hi" / "thanks". The greeting check was:

```ts
/^(안녕|고마워|감사|thanks?|thank you|응|ㅇㅇ|네|넵|오키|좋아|하이)\b/i
```

`\b` is an ASCII word boundary — it only matches between a `\w`
(`[A-Za-z0-9_]`) char and a non-`\w` char. Korean (Hangul) chars are
NOT `\w` without Unicode-property awareness, so `\b` NEVER matches
after a Hangul greeting:

```
/^안녕\b/i.test("안녕")  // → false   ← every Hangul greeting failed
/^thanks\b/i.test("thanks") // → true (ASCII works)
```

So `안녕`, `고마워`, `응`, `ㅇㅇ`, `네`, `넵`, `오키`, `좋아`, `하이` were
all dead branches — a Korean "안녕" got the full verified-sources
treatment instead of a casual reply. Significant for a Korean-first
assistant. (The line-113 unanchored Korean gratitude substrings —
`감사`/`전해줘`/… — still worked; only the line-112 greetings were broken.)

## Slice

Replace the ASCII `\b` with a Unicode-aware "whole-token" boundary —
a negative lookahead asserting no letter/number follows — under the
`u` flag:

```ts
/^(안녕|…|하이)(?![\p{L}\p{N}])/iu
```

This matches a bare/punctuated/spaced greeting (`안녕`, `안녕!`,
`안녕 뭐해`, `네`, `하이`, `thanks`) but NOT a longer word that merely
starts with one (`네이버`, `thanksgiving`).

## Verify

- `@muse/agent-core` is-casual-prompt-text.test.ts (new): the Hangul
  greetings now read casual; `네이버 검색해줘` / `thanksgiving plans` do
  NOT false-positive; English greetings still match; the unanchored
  gratitude path (`…감사하다고 전해줘`) and empty prompt still casual.
  **Mutation-proven** — restoring `\b` fails the Hangul case.
- Full `@muse/agent-core` suite green (677) — no existing test
  regressed (the verified-sources casual test uses the line-113 path).
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). Deterministic
  text classifier (decides whether to append a sources block) — not the
  model request path, so no `smoke:live`.

## Decisions

- **`(?![\p{L}\p{N}])`, not dropping the boundary** — a bare prefix
  match would over-trigger (`네` inside `네이버`); the Unicode lookahead
  keeps the whole-token intent that `\b` was reaching for, correctly
  across scripts.
- **Left `안녕하세요` (no-space formal greeting) unmatched** — matching
  it needs prefix-matching that risks `네이버`-style false positives;
  this fix is a strict improvement (bare/punctuated greetings now work,
  zero regressions, no new false positives) without that risk.
