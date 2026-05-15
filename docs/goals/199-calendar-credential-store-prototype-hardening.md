# 199 — calendar credential store can't leak Object.prototype members

## Why

Same bug class as goal 198, in `FileCalendarCredentialStore`.
All three public methods funnel through `readAll()`, which
returned `{ ...parsed.providers }` (or `{}` on
missing/bad-JSON) — a normal `Object.prototype`-backed map:

- `load("toString")` → `all.providers["toString"]` →
  `Object.prototype.toString` (a function, truthy) →
  `{ ...entry }` spreads a function → `{}`. The caller gets a
  **bogus empty-but-truthy credentials object** instead of
  `undefined`, so a "do we have creds for this provider?"
  check false-positives. `"constructor"` → the `Object`
  constructor, same result. This held even for a fresh store
  with no file (the `{}` fallback paths).
- `remove("toString")` → `"toString" in all.providers` is
  `true` via the prototype chain → it proceeds past the early
  return and does an unnecessary destructure + rewrite.

`providerId`s are config/setup-driven ("google", "icloud",
"caldav"); a typo or hand-edited file reaching `toString` /
`constructor` / `__proto__` is plausible, and a credential
store silently claiming-then-mishandling a provider is a bad
failure mode.

## Scope

- `packages/calendar/src/credential-store.ts`: add
  `emptyProviderMap()` returning `Object.create(null)` and use
  it for every `readAll()` return path (missing file, bad
  JSON, wrong shape, and the parse-success path — which now
  copies own entries into the null-proto map). `readAll` is
  the single chokepoint, so `load` / `remove` / `list` / `save`
  are all fixed at once with no per-method change. A
  hand-edited `__proto__` key is contained (own data prop on a
  null-proto object, no prototype mutation).
- `packages/calendar/test/calendar.test.ts`: new case — the
  four prototype-colliding ids `load → undefined` and
  `remove → no-op` on a fresh store; a real provider still
  round-trips; `load("toString")` stays undefined alongside a
  real entry; a hand-edited `__proto__` file is contained
  (sibling resolves, no global `clientId` pollution,
  `list()` still works).

## Verify

- `pnpm --filter @muse/calendar test` — 14 pass (1 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Deterministic file/JSON store — no model invoked, no
  smoke:live needed (consistent with goals 194–197).

## Status

done — the calendar credential store joins the persona store
(198) in being immune to prototype-name provider ids: no
false-positive `load`, no spurious `remove` rewrite, and
hand-edited `__proto__` keys are contained by a null-prototype
provider map.
