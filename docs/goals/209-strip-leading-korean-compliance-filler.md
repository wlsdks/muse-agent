# 209 — strip a leading Korean compliance filler (물론이죠! / 알겠습니다. / …)

## Why

The Korean counterpart of goal 208, and higher leverage —
Korean is the user's primary language. Goal 208 added a
leading-compliance-filler strip to the **English**
greeting-strip filter. The **Korean**
`createGreetingStripResponseFilter` still only stripped Korean
greetings (안녕하세요 / 반갑습니다 / …) and follow-up greetings
(좋은 아침이에요 / …). It did **not** touch the leading
compliance filler Qwen-class models emit constantly in Korean
with reasoning off:

- 물론이죠! / 물론입니다. / 물론이에요! ("of course")
- 알겠습니다. / 알겠어요. ("understood / got it")
- 네! / 네. ("yes")
- 그럼요! ("sure")
- 당연하죠! / 당연합니다. ("certainly / absolutely")

Same JARVIS-persona problem as 208 (terse, no excessive
enthusiasm), in the language the user actually uses most.

Also: the Korean greeting filter had **no direct unit test**
(only implicit coverage via one `agent-runtime.test.ts`
integration) — an implicit-only-coverage gap per the testing
rules.

## Scope

- `response-filters-greeting-strip.ts`
  (`createGreetingStripResponseFilter`): add one conservative
  `leadingFillerPattern`
  `/^\s*(?:물론(?:이죠|입니다|이에요|이지요|이야)?|알겠습니다|
  알겠어요|네|그럼요|당연(?:하죠|합니다|하지요|해요|히)?)
  \s*[!?.]\s+/u`, applied as the first `.replace()` in the
  existing chain (mirrors the 208 ordering, so
  "물론이죠! 안녕하세요! X" → "X"). The trailing `\s+`
  (one-or-more, unlike the greeting patterns' `\s*`) requires
  content after the punctuation, so a one-word reply ("네.",
  "물론입니다.") is never nuked to empty and real content
  starting with the word ("물론 그것도 가능합니다",
  "당연히 맞는 말씀입니다") is never touched. No new filter /
  no wiring change — rides the existing
  `greeting-strip-response-filter` stage, enabled by default.
- New `packages/agent-core/test/korean-locale-filters.test.ts`
  (parallel to `english-locale-filters.test.ts`): 6 filler
  strip variants + filler-then-greeting chain + 3 conservative
  non-strip cases + existing leading/follow-up greeting +
  no-op assertions — closing the direct-coverage gap for this
  filter at the same time.

## Verify

- `pnpm --filter @muse/agent-core test` — 523 pass (39 files;
  new Korean test file added).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Verification scope (transparent, same as 208): pure
  deterministic string filter, exhaustively unit-tested
  (authoritative per the testing rules), wired by default.
  Real Qwen Korean round-trip (ollama/qwen3:8b, reasoning off)
  through the agent-runtime+filters path:
  `muse ask --with-tools --notes-only "프랑스의 수도는
  어디인가요? 한 문장으로만 답하세요."` →
  `프랑스의 수도는 파리입니다. [from journal/…]` — clean
  Korean, no leading filler, no regression. A *live* strip
  can't be screenshotted (qwen3:8b output is
  non-deterministic; the CLI surfaces no filter provenance) —
  same honest-scope stance as goals 207/208.

## Status

done — the Korean greeting-strip stage now also removes a
single leading compliance filler, conservatively, and the
filter finally has direct unit coverage. The terse-JARVIS
output polish (208 English, 209 Korean) is symmetric across
both default locales.
