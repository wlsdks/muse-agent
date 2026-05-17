# 251 — entity-encoded zero-width chars evaded the injection guard

## Why

`findInjectionPatterns` (the deterministic primitive behind the
fail-close `injection-input-guard`) first canonicalises text via
`normalizeForInjectionDetection` so evasions — zero-width chars,
homoglyphs, HTML entities, diacritics, NFKC compatibility forms —
are folded out before the regex patterns run.

The composition order was:

```ts
stripDiacriticalMarks(replaceHomoglyphs(
  decodeHtmlEntities(stripZeroWidth(text).normalize("NFKC"))))
```

`stripZeroWidth` ran on the **raw** text, *before*
`decodeHtmlEntities`. So a zero-width character supplied as an
HTML numeric entity — `igno&#x200b;re all previous
instructions` — was still the literal ASCII `&#x200b;` when
`stripZeroWidth` ran (nothing to strip), and was only decoded to
real U+200B **after** the strip step. The decoded zero-width
survived into the matched string, splitting the keyword
(`igno<U+200B>re`), so `/(ignore|forget|disregard)…/` never matched
and the role-override injection passed the guard. The same hole
applied to `&#0;` (NUL) and any zero-width / bidi codepoint that
can be numeric-entity encoded — a one-character, trivially
automatable bypass of a security guard.

## Scope

`packages/policy/src/injection-patterns.ts` —
`normalizeForInjectionDetection` reordered so HTML entities are
decoded **first**, then NFKC, then zero-width stripping, then
homoglyph and diacritic folding:

```ts
stripDiacriticalMarks(replaceHomoglyphs(
  stripZeroWidth(decodeHtmlEntities(text).normalize("NFKC"))))
```

Now an entity-encoded zero-width is decoded to its real codepoint
*before* `stripZeroWidth`, so it is removed and the keyword
re-forms. Decoding before NFKC is also strictly more correct: an
entity that decodes to a compatibility character (e.g.
`&#xff11;` → fullwidth 1) is now NFKC-folded too, which the old
order missed. One expression changed; no pattern or API change.

## Verify

- `pnpm --filter @muse/policy test` — 52 pass (was 51; +1). New
  test asserts
  `normalizeForInjectionDetection("igno&#x200b;re all previous
  instructions") === "ignore all previous instructions"` and that
  `findInjectionPatterns(...)` then reports `role_override`. The
  existing combined-evasion test
  (`"&#73;gn<U+200B>оre prëvious" → "Ignore previous"`)
  and every homoglyph / diacritic / multilingual case still pass —
  the reorder preserves all prior normalisation behaviour.
- `pnpm check` — every workspace green (policy 52, apps/cli 555,
  apps/api 155, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (pure deterministic
  text normalisation in a security primitive). The threat is an
  adversarial input a benign turn never produces, so the
  deterministic unit test injecting the exact bypass string is the
  rigorous verification — the same stance the control-byte sweep
  used for every pure security transform.

## Status

done — an HTML-numeric-entity-encoded zero-width / NUL / bidi
character can no longer slip past `stripZeroWidth` to split an
injection keyword. The injection-detection normaliser now decodes
entities before it strips, closing a trivial, automatable bypass
of the fail-close injection input guard.
