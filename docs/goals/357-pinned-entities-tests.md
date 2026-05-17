# 357 — extractPinnedEntities (JARVIS "remember the concrete nouns") had zero coverage

## Why

`extractPinnedEntities` (`@muse/memory`) pulls up to 5 anchor
phrases — issue keys (`PROJ-1234`), Korean/English domain-noun
phrases (`결제 모듈`), quoted terms (`"q3 budget memo"`) — from
the user-authored turns being compacted out of the
conversation, and folds them into the `[Conversation summary:
…]` system message so the model keeps concrete nouns after the
originating turns are trimmed. That is a JARVIS-defining
"remember what the user actually talked about across a long
session" capability.

It is real, branchy text-processing (three regexes, a role
filter, a Set dedup, whitespace normalisation, a 5-entity cap)
and had **zero** test references in `@muse/memory` — an
implicit-only-coverage gap per testing.md, non-tautological
(unlike a pure pass-through), on a memory path where a silent
regression (e.g. pinning assistant output, dropping the cap,
losing dedup) would quietly degrade long-session recall.

## Scope

Test-only. New `packages/memory/test/pinned-entities.test.ts`
(imported directly from `../src/pinned-entities.js`; not
barrel-exported — same approach as goals 341/351), 7 cases:

- issue key from a **user** turn; assistant/system turns with
  issue keys **ignored** (role filter — the model's own
  output must not be pinned);
- `A-1` is **not** an issue key but `AB-1` is (the
  `[A-Z][A-Z0-9]+-\d+` 2+-char-prefix boundary);
- a Korean domain-noun phrase + a quoted term both captured;
- dedup of the same entity across turns;
- the 5-entity cap (7 keys → exactly 5);
- whitespace normalisation inside a quoted term;
- a turn with no anchor patterns → `[]`.

Every expected value was **empirically verified against the
built module before asserting** — which caught a real nuance:
the entity-noun group is greedy across preceding words, so
`fix the 결제 모듈` (not `결제 모듈`) is the actual pinned
value. The test asserts the true behaviour (`.toContain("결제
모듈")` plus the documented greedy-prefix) rather than a guessed
one. No production code changed — this locks the real contract.

## Verify

- `pnpm --filter @muse/memory test` — 160 pass (+7; new file).
  The existing auto-extract / importance / pattern / token-trim
  memory suites stay green.
- `pnpm check` — every workspace green (memory 160, apps/cli
  611, apps/api 161, all packages). `pnpm lint` — exit 0. The
  goal-227 enforcement test (328) stays green; the test file
  self-scans clean (Korean text is normal printable, no raw
  control/zero-width bytes).
- No real-LLM request/response path touched — deterministic
  string extraction. The deterministic suite, with the
  pre-write empirical verification, is the rigorous
  verification.

## Status

done — the pinned-entity extractor now has direct coverage of
its role filter, issue-key boundary, Korean/quoted capture,
dedup, 5-entity cap, whitespace normalisation, and the
greedy-prefix nuance, closing an implicit-only-coverage gap on
the long-session "remember the concrete nouns" memory path. No
behaviour changed.
