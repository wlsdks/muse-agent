# 198 — persona ids can't leak Object.prototype members

## Why

`muse persona use <id>` gated existence with
`isBuiltinPersonaId(trimmed) || trimmed in store.custom`. The
`in` operator walks the prototype chain, so
`"toString" in {}` / `"constructor"` / `"hasOwnProperty"` /
`"__proto__"` all return `true`. Concrete bug chain
(confirmed via node):

1. `muse persona use toString` → `exists` is `true` → it
   prints "active persona → toString" and persists
   `activeId: "toString"`.
2. `resolveActivePersonaPreamble` then did
   `store.custom["toString"]` → `Object.prototype.toString`
   (a function, truthy) → `.preamble` is `undefined` →
   `.preamble.length` throws
   `TypeError: Cannot read properties of undefined`.
3. `muse persona show` calls the resolver directly with no
   catch → the CLI crashes with a raw TypeError stack. The
   system-prompt path (`loadActivePersonaPreamble`) swallows
   it to `""`, so the persona silently stops working with no
   diagnostic.

So a single fat-fingered id (`toString` is a plausible typo
target) corrupts persisted state and crashes / silently
disables the persona system. A hand-edited `persona.json`
with a `__proto__` custom key was a second, related footgun.

## Scope

- `apps/cli/src/commands-persona.ts`: `trimmed in store.custom`
  → `Object.hasOwn(store.custom, trimmed)` — only a real
  custom id counts as existing.
- `apps/cli/src/persona-store.ts`:
  - `resolveActivePersonaPreamble` reads the custom entry only
    when `Object.hasOwn(store.custom, activeId)`, so a
    prototype-colliding `activeId` resolves to `undefined`
    (→ `""`) instead of an inherited member that throws. This
    is defensive regardless of how the injected store was
    built (the function is documented as pure / test-injected).
  - `readPersonaStore` accumulates `custom` into an
    `Object.create(null)` map so a hand-edited `__proto__` /
    `constructor` key can't mutate a real prototype or leak an
    inherited member through later bracket access.
  - Removed the stale `goal 094` comment markers in both
    files (hard constraint: no goal/round markers in source).

## Verify

- `pnpm --filter @muse/cli test` — 499 pass (1 new: the four
  prototype-colliding ids → `""` with no throw; null-proto
  containment + no global pollution; a valid built-in still
  resolves; CLI `persona use toString` rejected, exit 1).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Persona feeds the system prompt, so dog-fooded on real Qwen
  (ollama/qwen3:8b, reasoning off): `persona use jarvis` →
  accepted; `persona use toString` → "no persona with id
  'toString'", exit 1; `muse ask --persona jarvis "…
  operational?"` → "Yes, sir, I am operational and monitoring
  the system." — the valid-persona prompt path is byte-for-
  byte unchanged.

## Status

done — persona ids that collide with Object.prototype member
names no longer false-exist, corrupt persisted state, or crash
the resolver; hand-edited `__proto__` keys are contained by a
null-prototype custom map. Valid personas are unaffected.
