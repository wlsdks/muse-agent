# 416 — Exemplar scoring keeps single-syllable Korean query terms

## Why

Relevance/quality fix on a fresh axis (`@muse/prompts` — never
touched by the recent model/autoconfigure/scheduler/calendar
cluster), high leverage: `scoreExemplar` decides WHICH few-shot
"Answer Quality Examples" are injected into the system prompt for
every retrieval-backed turn, so a scoring blind spot directly
degrades LLM answer quality.

`tokenSet` (used by `scoreExemplar` for both the query and the
exemplar haystack) ended with `.filter(token.length >= 2)`. For
English that correctly drops single-letter noise. But Korean — a
primary user language (the codebase already special-cases it in
`policy/topic-drift.ts`: "Korean (the primary user language)
agglutinates…") — is information-dense: a single Hangul syllable
is a whole content word. Probed:

```
"물 마시는 법"  → ["마시는"]      (물=water, 법=method DROPPED)
"책 추천"       → ["추천"]        (책=book DROPPED)
"돈 관리 팁"    → ["관리"]        (돈=money, 팁=tip DROPPED)
```

So the single most salient noun of a Korean query never reached
the exemplar score; a query like `책` produced zero query tokens,
no scored match, and silently fell back to dumping the entire
exemplar file (or selecting irrelevant examples) — a systematic
few-shot degradation for the project's primary language, and an
inconsistency with the codebase's own established Hangul-aware
tokenisation elsewhere.

## Slice

- `packages/prompts/src/index.ts` — `tokenSet`'s length filter is
  now `token.length >= 2 || /[가-힣]/u.test(token)`: a single
  ASCII letter/digit is still dropped as noise, but a single
  Hangul syllable is kept as the real content word it is. Scope
  held to the filter — the split regex (already `a-z0-9가-힣`,
  i.e. EN+KO by design) is unchanged; no speculative widening to
  scripts the tokenizer doesn't retain.
- `packages/prompts/test/prompts.test.ts` — regression in the
  `exemplar retrieval` describe: a single-syllable Korean query
  (`책`) now selects the matching `[예시 1 - 책 추천]` exemplar
  and excludes the unrelated weather one. Fails on the pre-fix
  code (query token dropped → whole-file fallback → the excluded
  example leaks in).

## Verify

- `@muse/prompts` full suite 26/26 (2 files, +1); existing
  English exemplar tests unchanged (ASCII `length >= 2` behaviour
  is identical — no regression).
- `pnpm check` EXIT=0, every workspace green (prompts 26, cli
  717, …); tsc strict (prompts) clean; `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean (Hangul is normal UTF-8, not
  a control/zero-width byte).
- Deterministic token-scoring change verified with fixtures. Not
  a model request/response path (it selects which exemplars go
  into the prompt; the scoring itself is pure) — no `smoke:live`
  applies.

## Status

Done. Korean queries' single-syllable content words
(물/책/돈/…) now contribute to exemplar relevance scoring, so
the right few-shot examples are selected for the project's
primary language instead of being silently lost to a length
filter tuned for English.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a relevance/consistency fix to an existing
prompt-assembly helper, recorded honestly as a `fix(prompts):`
change with this backlog row — not a false metric.

## Decisions

- Predicate `length >= 2 || isHangul(1-char)` rather than
  lowering the global minimum to 1: a stray single ASCII letter
  IS noise in English and should still be dropped; only CJK/Hangul
  single chars carry word-level meaning. This mirrors the
  established `hasCjkChar` discipline in `topic-drift.ts` rather
  than inventing a new rule.
- Left the split regex alone: it already retains exactly the
  EN+KO set the project targets; broadening to Japanese/Chinese
  ranges has no observed failure and would be unreviewed scope
  creep.
