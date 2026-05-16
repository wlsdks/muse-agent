# 241 — greeting/filler strip only removed ONE lead-in; Qwen stacks them

## Why

Goals 208/209 added leading-compliance-filler stripping
("Sure!", "Of course!", "물론이죠!") on top of the existing
greeting strip — both on the live response-filter chain wired in
`packages/autoconfigure/src/response-filters.ts` (`ko` →
`createGreetingStripResponseFilter`, `en` →
`createEnglishGreetingStripResponseFilter`).

But each `apply` did:

```ts
response.output
  .replace(leadingFillerPattern, "")
  .replace(leadingGreetingPattern, "")
  .replace(...)            // each pattern is ^-anchored, non-global
  .trimStart();
```

An `^`-anchored `.replace` fires **once**. Reasoning-off
Qwen-class models routinely *stack* acknowledgements —
`"Sure! Of course! Paris."`, `"Sure! Certainly. Got it! Task
added."`, `"네! 그럼요! 당연하죠! …"` — and the chain removed only
the first one, so a second (and third) compliance filler leaked
straight into the JARVIS-persona reply. Order also mattered:
`"Hi there! Sure! Paris."` — the filler pass ran *before* the
greeting pass, so the `Sure!` that only becomes leading *after*
the greeting is stripped was never reconsidered.

## Scope

`packages/agent-core/src/response-filters-greeting-strip.ts`:

- New module-private `stripLeadingNoise(input, patterns)` — applies
  the anchored patterns in a bounded fixpoint loop (max 5 passes,
  `trimStart` each pass, stop as soon as a pass changes nothing).
  Both the Korean and English factories now delegate to it instead
  of a single fixed-order `.replace` chain.
- The 5-pass cap bounds worst-case work and guarantees termination
  (no ReDoS amplification — patterns run on a strictly shrinking
  prefix); a model never stacks anywhere near five distinct
  lead-ins.
- No pattern changes. The strip patterns still require
  `filler + [!?.] + \s + content`, so the no-over-strip guarantees
  are unchanged: `"Sure, the answer is Paris."`,
  `"Of course not."`, `"물론 그것도 가능합니다."` never match, so the
  first pass is a no-op and the loop exits with the response
  untouched (provenance `raw` still only stamped when the output
  actually changed).

## Verify

- `pnpm --filter @muse/agent-core test` — 532 pass. New English +
  Korean cases assert stacked / cross-order lead-ins fully strip
  (`"Sure! Of course! Paris." → "Paris."`,
  `"Hi there! Sure! Paris." → "Paris."`,
  `"네! 그럼요! 당연하죠! 작업을 추가했습니다." → "작업을 추가했습니다."`).
  The existing "does NOT strip real content that merely starts
  with a filler word" guards still pass — confirms the loop never
  over-strips.
- `pnpm check` — every workspace green (agent-core 532, apps/cli
  554, apps/api 153, all packages). `pnpm lint` — exit 0.
- Real-LLM round-trip (response-filter path touched): `muse ask`
  against Ollama `qwen3:8b`, reasoning off
  (`OLLAMA_BASE_URL=127.0.0.1:11434 MUSE_MODEL=ollama/qwen3:8b
  GEMINI_API_KEY=""`). The reply came back filler-free and
  persona-correct ("The capital of France is Paris.", no "Sure!"/
  "Of course!" prefix, substantive content intact), confirming the
  rebuilt filter is live on the real Qwen path and does not
  regress the single/no-filler cases. (Qwen did not emit a stacked
  filler in that particular sample — that case is exhaustively
  pinned by the deterministic unit tests; the live run confirms
  wiring + non-regression, the appropriate split.)

## Status

done — stacked and cross-order lead-ins ("Sure! Of course! …",
"Hi there! Got it! …", "네! 그럼요! …") are now fully removed instead
of leaving the second one in the reply. The terse JARVIS persona
no longer leaks a compliance filler when a reasoning-off model
piles them up.
