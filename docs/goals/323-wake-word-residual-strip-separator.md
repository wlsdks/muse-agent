# 323 — wake-word residual leaked the pause-separator into the LLM prompt

## Why

`TextScanWakeWordDetector` is the default `muse listen --wake`
detector. On a hit it returns a `residual` — "Text after the
wake phrase, trimmed" (its own doc) — which the wake loop feeds
**directly to the model as the prompt** without recording
another clip. `findWholePhrase` built that residual as:

```ts
return { matched: true, residual: original.slice(i + 1).trim() };
```

`.trim()` only strips whitespace. The **overwhelmingly common
natural phrasing** puts a pause comma (or dash / ellipsis)
right after the wake word — *"Hey Muse, what's the weather?"*,
*"Muse — open the door"*, *"Hey Muse... remind me"* — so the
residual became `", what's the weather?"` / `"— open the door"`
/ `"... remind me"`, and **that leading punctuation was fed to
the LLM as the prompt**. A degraded prompt on the single
highest-frequency voice interaction, and the kind of rough edge
a JARVIS-class assistant should not have.

The existing tests masked it: they asserted the residual with
loose `.toContain(...)` (e.g. `result.residual).toContain("open
the deploy doc")`) precisely *because* the leading separator was
known-present — only the comma-free input got a strict `.toBe`.

## Scope

`packages/voice/src/wake-word.ts` — `findWholePhrase`:

- Strip the leading separator run from the residual with
  `/^[\p{P}\p{S}\s]+/u` before `.trim()`. This is the **same**
  `[\p{P}\p{S}\s]` character class the function already uses one
  line above for its post-phrase word-boundary check, so the
  definition of "separator after the wake phrase" is consistent
  by construction — if a char is a valid boundary terminator for
  *matching* the phrase, it is separator noise for the *residual*
  too. One short WHY comment (non-derivable intent: keep pause
  punctuation out of the LLM prompt).

Behaviour-preserving for the already-clean cases — a
space-separated residual (`"Hey Muse what's…"`) is unchanged
(the leading-`\s` strip then trim is identical to the old
`.trim()`); a tail-only hit (`"Hey muse"`) still yields `""` →
`detected` without `residual`. Only the leading-separator noise
is removed.

## Verify

- `pnpm --filter @muse/voice test` — 64 pass (was 63; +1). New
  dedicated test asserts the canonical pause-comma /
  ellipsis phrasings (`"Hey Muse, what's the weather?"` →
  `"what's the weather?"`; `"Hey Muse... open the door"` →
  `"open the door"`). Two pre-existing **loose `.toContain`
  assertions tightened to exact `.toBe`** (the
  whitespace+punctuation test and the bare-alias
  `"muse, what's next?"` → `"what's next?"`) — they are now real
  regression guards instead of wart-accommodating checks. All
  other wake-word tests (whole-word-only / aliases / tail /
  absent / empty) stay green.
- `pnpm check` — every workspace green (voice 64, apps/cli
  563, apps/api 161, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched — the detector is
  pure synchronous text processing that performs no I/O (its
  interface contract); the residual is *produced for* the model,
  not via a model round-trip. The deterministic regression is
  the rigorous verification (a live Qwen run cannot exercise
  STT-transcript edge punctuation on demand) — same stance as
  the parsing/edge-case goals.

## Status

done — the wake-word residual now strips the leading
separator run between the wake phrase and the prompt, so the
single most common voice phrasing ("Hey Muse, …") delivers a
clean prompt to the model instead of one prefixed with pause
punctuation. The previously-accommodating tests are now strict
regression guards.
