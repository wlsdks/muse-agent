# 497 — `goodTimeOfDayPattern` now accepts a comma-addressee like "Good morning, sir!" (sibling-asymmetry on the JARVIS persona filter)

## Why

`createEnglishGreetingStripResponseFilter`
(`@muse/agent-core` `response-filters-greeting-strip.ts:95`)
is the response filter that strips the "Sure! Hi there! Got it!"
compliance preamble the loop's local Qwen models routinely
emit, so the JARVIS persona stays dry / direct instead of
chatty. The filter declares **four** anchored patterns:

- `leadingGreetingPattern` (Hi / Hello / Hey / Howdy …) —
  **accepts** an optional `,\s*\w{1,20}` addressee suffix
  (`"Hi there, sir!"`).
- `goodTimeOfDayPattern` (Good morning / afternoon / …) —
  **rejected** any comma-addressee form because its addressee
  capture was `\s+\w{1,20}` (no comma allowed).
- `niceToMeetPattern` / `leadingFillerPattern` — no
  addressee form needed.

Asymmetry between the two greeting patterns: `"Hi there, sir!"`
was stripped, but `"Good morning, sir!"` was **not**. So a JARVIS
persona configured with an honorific would let
`"Good morning, sir! Reminder fires at 3pm."` reach the user
verbatim while `"Hi there, sir! Reminder fires at 3pm."` got
the preamble cleanly stripped — the exact persona-consistency
failure this filter exists to prevent.

Surfaced by the new direct test: `"Good morning, sir!
Reminder fires at 3pm."` expected `"Reminder fires at 3pm."`,
got `"Good morning, sir! Reminder fires at 3pm."`. Real
sibling-asymmetry defect on a JARVIS-defining behavior path,
caught and fixed in the same iteration.

The module had **no direct test coverage**: every behaviour
the filter promises was implicit-only.

## Slice

- `packages/agent-core/src/response-filters-greeting-strip.ts`
  — `goodTimeOfDayPattern`'s addressee capture group changed
  from `(?:\s+\w{1,20})?` to `(?:[,，]?\s+\w{1,20})?`. Same
  shape as `leadingGreetingPattern`'s `(?:,\s*\w{1,20})?`
  variant: an optional ASCII or fullwidth comma is accepted
  before the addressee. Behaviour byte-identical for every
  previously-stripped form (`"Good morning!"`,
  `"Good morning sir!"`); only the comma-addressee path is
  newly stripped.
- `packages/agent-core/test/response-filters-greeting-strip.test.ts`
  — new file, first direct test of the module: 6 English
  tests (filler strip, leading greeting strip, **comma-
  addressee strip** — the goal-497 case — stacked-preamble
  multi-pass strip, never-strip-to-silence safety,
  Surely/Of-course-not non-strip) + 4 Korean tests (안녕하세요 /
  반갑습니다 / 좋은 아침이에요 / 물론입니다 / 알겠습니다 lead-in
  strips, never-strip-to-silence on `네.`, no-false-strip on
  `물론 그것도 가능합니다`).

## Verify

- New test 10/10 green; full `@muse/agent-core` suite green
  (626 passed, +10, 0 failed); tsc strict (agent-core)
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the regex
  to the prior `(?:\s+\w{1,20})?` capture group makes the
  comma-addressee test fail with the precise pre-fix symptom
  (`expected 'Good morning, sir! Reminder fires at …' to be
  'Reminder fires at 3pm.'` — the persona-undercutting
  preamble survives) while the other 9 tests stay green; fix
  restored, suite back to 10 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure regex / response-rewriting logic — no LLM / model
  request-response wire path (the filter consumes a
  ModelResponse; it doesn't issue a new request);
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. The JARVIS persona filter now strips
`"Good morning, sir!"` symmetrically with `"Hi there, sir!"`,
closing the sibling-asymmetry the new test surfaced. Every
previously-stripped form is unaffected. The module gains its
first direct test, pinning the four-pattern + pass-cap +
never-strip-to-silence contract.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry fix on a
JARVIS-defining persona behaviour, recorded honestly with
this backlog row — not a false metric.

## Decisions

- Used the `[,，]?\s+\w{1,20}` shape (optional ASCII OR
  fullwidth comma, then required `\s+` then word) rather than
  copying `leadingGreetingPattern`'s `(?:,\s*\w{1,20})?` form
  exactly. The fullwidth comma `，` (U+FF0C) is the comma
  Korean / Japanese / CJK writers use; a multilingual user
  with a JARVIS persona who says
  `"Good morning，sir!"` deserves the same strip. The result
  is byte-identical for every input the prior regex matched.
- Distinct defect class from the recent empty-env-shadow run
  (478/481/482/483/488/495) and from the test-only run
  (487/491/492/496) — Step-8 mix maintained.
