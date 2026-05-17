# 327 — raw zero-width bytes in two goal docs (closes the goal-227 sweep)

## Why

Goals 325 (test source) and 326 (production CLI source) cleared
the raw-control-byte violations of the goal-227 rule (no raw
control / zero-width / homoglyph bytes in committed source OR
docs — describe with escape notation). The repo-wide enforced
scan
(`perl -CSD … /[\x00-\x08\x0b-\x1f\x7f]|\x{200b}|\x{200c}|\x{200d}|\x{feff}/`)
left exactly two docs with a raw **U+200B (zero-width space)**:

- `docs/goals/238-import-zip-slip-confinement.md:55` — one
  U+200B sitting between `file/` and `function` ("the
  misleading file/<ZWSP>function comment"). Pure accidental
  paste noise — invisible, meaningless, and it makes the line
  trip the pre-commit scan forever.
- `docs/goals/251-injection-normalize-decode-before-strip.md:25,58`
  — two U+200B that are *intentional illustration* of the
  zero-width-injection bug that doc is about (`igno<ZWSP>re`
  splitting the keyword; the `&#73;gn<ZWSP>ore` evasion test
  fixture). The rule's whole point is that even illustrative
  zero-widths must be written as escape *notation*, never raw
  bytes — otherwise the doc that explains a zero-width attack is
  itself carrying the raw attack byte.

These were the last enforced-scan hits; closing them makes the
repo-wide goal-227 scan fully clean.

## Scope

Docs only — no source / test / production code touched.

- `238:55` — strip the stray U+200B
  (`s/\x{200b}//g`, perl-confirmed exactly 1 in the file) →
  reads "file/function".
- `251:25,58` — replace each U+200B with the literal escape
  notation `<U+200B>` (`s/\x{200b}/<U+200B>/g`, perl-confirmed
  exactly 2) so the doc still shows precisely *where* the
  zero-width split the keyword, but as readable text instead of
  a raw byte (e.g. `igno<U+200B>re`).

Doc meaning is preserved — 238's sentence is unchanged in
intent, and 251 still demonstrates the exact split points of the
zero-width injection, now legibly. Scope is held to the
**enforced** scan set (control / zero-width / BOM); the
deliberate Cyrillic-homoglyph examples 251 also discusses are
labelled illustration, are not matched by the pre-commit gate,
and rewriting them is out of scope for this tight iteration.

## Verify

- Repo-wide enforced scan across every tracked
  `.ts/.tsx/.js/.mjs/.cjs/.md/.json/.rs` file now reports
  **zero** `BAD` lines — the goal-227 violation class is closed
  (no raw control / zero-width / BOM byte anywhere in committed
  source or docs).
- `git status` confirms the diff is **docs-only** (the two goal
  docs); no code path can be affected.
- `pnpm lint` — exit 0. `pnpm check` — every workspace green
  (apps/cli 563, apps/api 161, all packages) — confirms the
  docs-only change regressed nothing.
- No real-LLM request/response path touched. The scan + green
  gate are the rigorous verification.

## Status

done — the two remaining raw-U+200B goal docs are fixed (stray
one removed; the two illustrative ones rewritten as `<U+200B>`
escape notation), and the repo-wide enforced goal-227 scan is
fully clean. The control / zero-width / BOM raw-byte hygiene
class is now closed across the entire repository (goals
325 → 326 → 327).
