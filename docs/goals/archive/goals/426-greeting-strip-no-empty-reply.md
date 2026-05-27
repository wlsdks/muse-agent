# 426 — Greeting-strip never empties a greeting-only reply

## Why

Correctness/UX fix on a fresh axis (`agent-core` response
filters — they shape EVERY agent reply; never touched by the
recent cli/calendar/shared/messaging cluster).

The greeting-strip filters remove a leading salutation/filler
preamble ("Hi there! …", "안녕하세요! …", "Sure! …") so the JARVIS
persona stays terse. Both `createGreetingStripResponseFilter`
(Korean) and `createEnglishGreetingStripResponseFilter` guarded
the *input* being empty, and the no-op case, but **not the
stripped output being empty**. When the model's entire reply IS
just a greeting/filler (reasoning-off Qwen does this for trivial
/ social turns like "hi" / "안녕"), the whole reply was stripped
to `""`. Probed (built dist):

```
"안녕하세요!"    → ""   *** EMPTY REPLY ***
"Hi there! "   → ""   *** EMPTY REPLY ***
"Sure! "       → ""   *** EMPTY REPLY ***
"안녕하세요! 오늘 일정은 3개입니다."  → "오늘 일정은 3개입니다."  (correct — preamble only)
```

Combined with goal 422's inbound path (an empty reply is marked
"handled" and nothing is sent), a user who greets Muse gets
**total silence**. The filter's job is to strip a *preamble*
before substantive content, not to delete a reply that is *only*
a greeting — an un-stripped greeting beats silence. (The sibling
`casual-lure-strip` already guards against emptying with multiple
`return response` paths; this gap was specific to greeting-strip.)

## Slice

- `packages/agent-core/src/response-filters-greeting-strip.ts` —
  in BOTH filters, after `stripLeadingNoise`, add
  `if (output.trim().length === 0) return response;` (return the
  ORIGINAL reply) immediately before the existing no-op guard.
  Mirrors the function's own top-of-apply empty-input guard;
  greeting+content replies are unaffected (the preamble is still
  stripped exactly as before).
- `packages/agent-core/test/korean-locale-filters.test.ts` /
  `english-locale-filters.test.ts` — a regression in each
  filter's describe: greeting-only / filler-only replies
  (`안녕하세요!`, `반갑습니다!`, `네! 물론이죠! ` / `Hi there! `,
  `Good morning! `, `Sure! `, `Of course! `) are returned whole.
  Fails on the pre-fix code (each → `""`).

## Verify

- `@muse/agent-core` korean+english locale filter suites 34/34
  (existing greeting+content / no-op / non-greeting cases all
  unchanged — no regression); full `@muse/agent-core` suite green
  (48 files / 587); tsc strict clean.
- `pnpm check` EXIT=0, every workspace green (agent-core 587, cli
  731, …); `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan
  clean (Hangul is normal UTF-8).
- Deterministic post-processing filter verified with synthetic
  `ModelResponse` fixtures — not a real model request/response
  path, so no `smoke:live` applies.

## Status

Done. A greeting-only model reply now reaches the user intact
instead of being stripped to silence — the filter still trims a
greeting *preamble* before real content exactly as before, but
never deletes the whole turn. Closes the worst interaction with
goal 422 (greet Muse → handled, nothing sent → silence).

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; a correctness fix to an existing filter, recorded
honestly as a `fix(agent-core):` change with this backlog row —
not a false metric.

## Decisions

- Return the ORIGINAL response (not a trimmed/partial one) when
  the strip would empty it: the safest, least-surprising
  behaviour and consistent with the existing empty-input guard.
- Scoped to greeting-strip (the identified gap, both its filters
  in one file); did not touch casual-lure-strip (verified it
  already guards against emptying — no speculative churn).
- Caught a self-inflicted test misplacement (the English
  regression first landed in the `ZeroResultOverclaim` describe
  via the file's final `});`); relocated it into the correct
  `createEnglishGreetingStripResponseFilter` describe and
  re-verified — recorded so the near-miss is visible.
