# 208 — strip a leading compliance filler ("Sure!", "Certainly.", …)

## Why

A fresh output-quality gap (the error-swallow sweep 201–207 is
done). The response-filter chain already strips:

- leading **greetings** ("Hi!", "Hello,", "Good morning!",
  "Nice to meet you") — `response-filters-greeting-strip.ts`
- trailing **closing pleasantries** ("Hope this helps!",
  "Let me know if you need anything else.") —
  `response-filters-casual-lure-strip.ts`

Neither touches the **leading compliance filler** Qwen-class
models emit constantly with reasoning off: "Sure! …",
"Certainly. …", "Of course! …", "Got it! …", "Understood. …",
"No problem! …". It is neither a greeting nor a trailing lure,
and it directly undercuts the JARVIS persona contract ("Keep
replies brief … Avoid … excessive enthusiasm. Stay precise.").
"Sure! The capital of France is Paris." should read "The
capital of France is Paris."

## Scope

- `apps/.../response-filters-greeting-strip.ts`
  (`createEnglishGreetingStripResponseFilter`): add one
  conservative `leadingFillerPattern`
  `/^\s*(?:Sure(?:\s+thing)?|Certainly|Of\s+course|Absolutely|
  Got\s+it|No\s+problem|Sounds\s+good|Understood|Alright(?:y)?)
  \s*[!?.]\s+/iu`, applied as the first `.replace()` in the
  existing chain (filler is almost always the leading-most
  token; running it before the greeting strip also handles
  "Sure! Hi there! X" → "X"). It only strips when the filler
  word is immediately closed by `[!?.]` + whitespace + more
  content, so real content that merely starts with the word
  ("Surely…", "Of course not.", "Absolutely fascinating:",
  "Sure, the answer is X") is never touched, and a one-word
  "Sure." can never be nuked to empty. Same conservative
  philosophy as the sibling greeting/time-of-day patterns. No
  new filter, no wiring change — it rides the existing
  `english-greeting-strip-response-filter` stage, already
  enabled by default (`MUSE_RESPONSE_GREETING_STRIP_ENABLED`
  default true; default locales `["ko","en"]`).
- Tests added to `english-locale-filters.test.ts`: 6 strip
  variants (incl. filler-then-greeting chained) + 4
  conservative non-strip cases.

## Verify

- `pnpm --filter @muse/agent-core test` — 517 pass (3 new
  blocks).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Verification scope (transparent): the filter is a pure
  deterministic string transform, exhaustively covered by the
  10 new unit assertions (the authoritative verification per
  the testing rules). It is confirmed wired by default. Real
  Qwen round-trips (ollama/qwen3:8b, reasoning off) through
  both the chat-only fast path and the agent-runtime+filters
  path returned clean, coherent answers with no leading filler
  and no regression. I could not capture a *live* strip:
  qwen3:8b ignores "reply with exactly …" instructions and
  imposes its own persona, so a leading "Sure!/Certainly!"
  can't be forced on demand, and the CLI surfaces no filter
  provenance — so the end-to-end strip is proven by the
  deterministic unit tests + wired-by-default + the
  no-regression live runs, not a screenshot of the live strip
  (same honest-scope stance as goal 207).

## Status

done — the English greeting-strip stage now also removes a
single leading compliance filler, conservatively (never over-
strips real content, never empties a one-word reply),
sharpening the JARVIS terseness on the most common Qwen
reasoning-off lead-in.
