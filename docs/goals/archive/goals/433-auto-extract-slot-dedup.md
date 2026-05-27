# 433 — Auto-extract dedupes veto/goal slots by id

## Why

Persona-quality / safety + consistency fix on a fresh axis
(`@muse/memory` `memory-auto-extract` — the hook that mines
facts/prefs/**vetoes/goals** from a turn into `UserMemoryStore`,
which feeds the persona block on every future reply; not touched
by the recent voice/cli/api cluster).

`sanitizeEntries` handles facts/preferences, which are
Record-shaped, so duplicate keys collapse for free — and a code
comment elsewhere asserts "sanitize dedupes". But its sibling
`sanitizeSlotArray` (vetoes + goals) consumes an **array** of
`{id,value,scope}` and did **not** dedupe by `id`. So if the
reasoning-off extractor re-emitted a near-duplicate veto/goal —
common qwen3 behaviour, the same model-quirk class goal 403
hardened the verdict parser for — both occurrences consumed a
`maxVetoesPerExchange` / `maxGoalsPerExchange` slot (default 3):

```
vetoes:[coffee, coffee, sugar, salt]  (cap 3)
  pre-fix → persists {coffee(last-wins), sugar}    ← "salt" SILENTLY DROPPED
  post-fix → persists {coffee(first), sugar, salt} ← all 3 distinct kept
```

A *distinct* veto the user actually stated ("never do these")
was silently lost because a re-emitted duplicate ate the cap —
a real persona-safety regression, and a documented-invariant
("sanitize dedupes") that was false for the slot path (the 429
class).

## Slice

- `packages/memory/src/memory-auto-extract.ts` —
  `sanitizeSlotArray` now tracks a `Set<string>` of seen ids;
  a slot whose normalised id was already kept is skipped, and an
  id is marked seen only once a valid (non-empty value) slot is
  pushed (so an earlier empty-value occurrence doesn't block a
  later valid same-id one). First valid occurrence wins; a
  duplicate no longer consumes a cap slot. Mirrors the implicit
  Record-key dedupe `sanitizeEntries` already gets for free.
- `packages/memory/test/auto-extract-sanitize.test.ts` —
  regression: a payload with a duplicated `coffee` veto plus
  distinct `sugar`/`salt` (4 slots, cap 3) → persisted veto ids
  are exactly `[coffee, salt, sugar]` (salt NOT lost) and
  `coffee`'s value is the first occurrence. Fails on the pre-fix
  code.

## Verify

- `@muse/memory` auto-extract-sanitize.test.ts 8/8 (+1); full
  `@muse/memory` suite green (12 files / 161, +1); the existing
  newline/array-shape/single-veto tests unchanged (dedupe is a
  no-op for single-occurrence slots — no regression); tsc strict
  (memory) clean.
- `pnpm check` EXIT=0, every workspace green (memory 161, api
  195, cli 737, …); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the two intended
  files.
- Deterministic post-processing sanitiser verified with a fake
  provider (the model output is faked — this is NOT the model
  request/response wire path); no `smoke:live` applies.

## Status

Done. A reasoning-off extractor that re-states the same
veto/goal no longer wastes a persona slot and silently drops a
distinct rule the user explicitly stated — vetoes/goals dedupe
by id the same way facts/preferences already do via Record-key
semantics. The "sanitize dedupes" invariant now holds for the
slot path too.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; a consistency/persona-safety fix to an existing
sanitiser, recorded honestly as a `fix(memory):` change with
this backlog row — not a false metric.

## Decisions

- First-valid-occurrence wins (not last): deterministic, simplest,
  and the cap-waste — not which duplicate wins — is the actual
  defect; marking `seen` only after a successful push keeps an
  empty-value early occurrence from shadowing a valid later one.
- Did not extract a shared dedupe helper between
  `sanitizeEntries` / `sanitizeSlotArray`: their dedupe
  mechanisms differ in kind (Record-key vs explicit Set), so a
  shared abstraction would obscure rather than clarify — the
  fix keeps each sanitiser self-evidently correct.
