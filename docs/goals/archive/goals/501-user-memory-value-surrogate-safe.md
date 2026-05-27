# 501 — `sanitizeUserMemoryValue` drops a lone surrogate at MAX_USER_MEMORY_VALUE_CHARS (goal-451/499/500 sibling, persona-expansion path)

## Why

`sanitizeUserMemoryValue` (`@muse/memory`
`memory-user-store.ts:49`) is the **persona-expansion
chokepoint**: every user-memory fact, preference, veto, and
goal the auto-extractor or `/fact` / `/pref` slash commands
write flows through this function before it lands in
`~/.muse/user-memory.json`. The persisted value is then
**re-injected into every subsequent prompt** via persona
expansion — the source comment makes this explicit (lines
51-53). So a corrupt persisted value flows into the LLM
context permanently, every turn.

Pre-fix the function did `slice(0, MAX_USER_MEMORY_VALUE_CHARS)`
(2048). If the cap fell inside an emoji's surrogate pair the
slice emitted a lone high surrogate — invalid UTF-8 once the
persona block JSON-stringifies through the chat API / SSE /
messaging providers. Real and reachable: an auto-extracted
memory like `"prefers concise replies 😀 …"` near the 2048-char
boundary silently corrupts every prompt thereafter.

This is the **fourth** consumer of the same defect class (after
451 / 499 / 500). Same shape, same byte-identical fix.

## Slice

- `packages/memory/src/memory-user-store.ts` — after
  `slice(0, MAX_USER_MEMORY_VALUE_CHARS)`, check
  `charCodeAt(head.length - 1)` for a high surrogate
  (`0xd800-0xdbff`) and drop with `slice(0, -1)`. Byte-
  identical pattern to goals 451 / 499 / 500. Behaviour
  byte-identical for every cap that doesn't land on a
  surrogate boundary.
- `packages/memory/test/memory-user-store-file.test.ts` —
  extended the existing `sanitizeUserMemoryValue` describe
  (5 prior tests untouched) with the emoji-at-boundary case:
  `"x" * 2047 + "😀" + filler` → `"x" * 2047` (the orphan
  dropped, no trailing high surrogate).

## Verify

- New test 6/6 green; the 5 pre-existing
  `sanitizeUserMemoryValue` tests still green (no wrong
  premise — none used surrogate-containing inputs near the
  boundary); full `@muse/memory` suite green (177 passed,
  +1 new it, 0 failed); tsc strict (memory) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  surrogate-drop block to a plain
  `return stripped.slice(0, MAX_USER_MEMORY_VALUE_CHARS)`
  makes the new emoji-at-boundary test fail while the other
  5 stay green; fix restored, suite back to 6 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure persistence-time sanitiser — no LLM / model
  request-response wire path (the function rewrites a value
  about to be persisted, then sanitised again at the
  persona-expansion read side); `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. An auto-extracted user-memory value with an emoji at the
2048-char boundary no longer flows a lone high surrogate into
every subsequent prompt via persona expansion. Together with
goals 451 / 499 / 500, the four known fixed-character-cap
surrogate-safety consumers are now mutation-proven; the
codebase-wide pattern is single-shaped at four sites.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a goal-451/499/500 sibling
correctness `fix:` on the persona-expansion chokepoint,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Mirrored goals 451 / 499 / 500's surrogate-drop shape
  byte-for-byte (length-precheck → slice → charCodeAt range
  check → slice -1). Four byte-identical fixes across
  `@muse/shared` / `@muse/agent-core` (×2) / `@muse/memory`
  keep the convention single-shaped — exactly the drift the
  next near-variant would introduce.
- Extended the existing
  `sanitizeUserMemoryValue (direct unit tests)` describe
  rather than adding a new test file: the five prior
  assertions are well-shaped and the new clause belongs in
  the same describe for visibility.
- Persona-expansion is a JARVIS-visible path: every turn
  reads these values back to the model. The fix lands on the
  highest-leverage instance of the class — a corruption here
  pollutes the entire conversation, not just one response.
