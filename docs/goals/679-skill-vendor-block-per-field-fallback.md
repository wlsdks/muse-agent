# 679 — `extractRequiresInstall` resolves `requires`/`install` per-field across the `muse` and `openclaw` metadata vendor blocks (muse wins per-field, falls through to openclaw) instead of returning on the first object-valued block, so a present-but-empty `muse: {}` can no longer silently drop a skill's binary-requirement gating

## Why

`packages/skills/src/skill-parser.ts:extractRequiresInstall` pulls a
skill's `requires` / `install` out of its `metadata` block. A skill
may carry a Muse-native namespace (`metadata.muse`) and/or an
OpenClaw-compat one (`metadata.openclaw`); the function checks them in
`["muse", "openclaw"]` order so the native namespace takes precedence.

The bug: it **returned on the first vendor block that was any
object**, spreading only that block's fields:

```ts
for (const vendor of ["muse", "openclaw"]) {
  const block = metadata[vendor];
  if (block && typeof block === "object") {
    const record = block as Record<string, unknown>;
    return {                                  // ← early return
      ...(record.requires ? { requires: record.requires } : {}),
      ...(record.install ? { install: record.install } : {})
    };
  }
}
```

So whenever `metadata.muse` was present but did not supply a field,
`metadata.openclaw`'s value for that field was lost:

- `muse: {}` (empty) + `openclaw: { requires, install }` → returns
  `{}`. The skill's `requires.bins` gating **vanishes** — the skill
  is treated as having no binary requirement and can run without the
  `gh` / `codex` / etc. it actually needs.
- `muse: { install }` + `openclaw: { requires }` → returns only
  `install`; the openclaw `requires` is dropped.

A present-but-empty `muse: {}` is a realistic marker an author adds to
flag "Muse-compatible" on a skill originally written for OpenClaw —
exactly the case that silently strips its requirement gating.

### Defect class

**Early-return masks a per-field fallback** — distinct from the
recent 10-iter window (value-range bound 678/673/671, i18n 677, sort
tiebreaker 676, base64 validation 675, strict parse 674, HTTP timeout
672). Fresh package (`@muse/skills`, untouched in the recent window).

## Slice

- `packages/skills/src/skill-parser.ts`:
  - `extractRequiresInstall` now accumulates `requires` and `install`
    independently across both vendor blocks, taking the **first**
    vendor that supplies each field (muse before openclaw). One WHY
    comment names the empty-`muse`-masks-openclaw scenario.
- `packages/skills/test/skill-parser.test.ts`:
  - **Three new tests**: (1) empty `muse: {}` must not mask
    openclaw's requires/install; (2) per-field fallback — muse
    `install` + openclaw `requires` both survive; (3) muse wins
    per-field when both define `requires`.

## Verify

- `pnpm --filter @muse/skills test`: 14 passed (11 prior + 3 new).
- **Clean-mutation-proven**: restoring the early-return form makes
  EXACTLY the empty-`muse`-mask and per-field-fallback tests fail
  (2 failed / 12 passed); the muse-wins test passes either way
  (muse-first ordering preserves it). Restored; all 14 green.
- `pnpm check`: EXIT=0 — every workspace builds + tests green
  (the `apps/cli test: actions failed` lines are commander
  error-path test stderr, not failures: 1147 cli tests pass).
- `pnpm lint`: 0 errors / 0 warnings.
- `guard:core`: clean. Byte-hygiene scan on both touched files: clean.
- No LLM request/response wire path touched — this is pure
  frontmatter parsing over an on-disk `SKILL.md`, so `smoke:live`
  does not apply.

## Status

Done.

| metadata blocks                                   | Pre-fix                  | Post-fix                       |
| ------------------------------------------------- | ------------------------ | ------------------------------ |
| `muse: { requires }` only                         | requires (muse)          | unchanged                      |
| `openclaw: { requires }` only                     | requires (openclaw)      | unchanged                      |
| `muse: {}` + `openclaw: { requires, install }`    | **`{}` (gating lost)**   | requires + install (openclaw)  |
| `muse: { install }` + `openclaw: { requires }`    | install only             | install (muse) + requires (oc) |
| both define `requires`                            | muse wins                | muse wins (unchanged)          |

## Decisions

- **Per-field, not whole-block, precedence** — the natural reading of
  "muse takes precedence over openclaw" is field-by-field: take
  muse's value for a field if present, else openclaw's. Whole-block
  precedence (the old behavior) discards a whole vendor's data the
  moment the higher-priority vendor exists at all, even empty.
- **`=== undefined` first-writer guard** rather than truthiness on the
  accumulator, so a deliberately falsy-but-present field can't be
  overwritten by a later vendor. (`record.requires` is still
  truth-tested on read, matching the original — a `requires: null`
  is treated as absent.)

## Remaining risks

- **`requires` / `install` shapes are not validated here** — the
  function forwards whatever JSON the vendor block holds; downstream
  `requires.bins` / `requires.anyBins` consumers assume string
  arrays. Schema-validating the merged shape is a separate concern
  (would belong in the skill loader / a zod guard), not this seam.
- **Only `muse` and `openclaw` namespaces are recognized** — a
  third-party vendor namespace is ignored. That's by design; adding
  one is a deliberate change, not a bug.
