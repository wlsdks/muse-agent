# TypeScript 7 configuration audit

Date: 2026-07-16

## Scope

- Checked every `tsconfig*.json` for TypeScript 6 deprecations removed by
  TypeScript 7 and for explicit modern module/type configuration.
- Reviewed the shared error and named-constant boundaries before adding new
  abstractions.

## Findings

- The workspace already uses `module` and `moduleResolution` `NodeNext`,
  `target` `ES2025`, `strict`, `noUncheckedSideEffectImports`, explicit Node
  types, and explicit package `rootDir` values. No removed TS7 option was
  found.
- `apps/web/tsconfig.json` redundantly listed `DOM.Iterable`. TypeScript 6+
  includes DOM iterable declarations through `DOM`, so the redundant entry was
  removed and the production web build passed.
- Stable public error codes use string-literal unions in their owning domains
  (for example, messaging and plan execution). Keep local constants colocated;
  use `as const` plus a derived union for shared runtime identifiers; use a
  TypeScript `enum` only when an emitted runtime object is required by an
  external contract.
- Shared error normalization remains in `@muse/shared`. Do not extract
  package-local error types or provider-specific dynamic codes without a
  demonstrated cross-package contract.

## Named-value modeling policy

Choose the narrowest representation that expresses the real contract. Do not
replace repeated strings mechanically: a string can be a local implementation
detail, a stable domain value, or untrusted provider data, and those have
different ownership and validation needs.

| Situation | Representation | Location |
| --- | --- | --- |
| One implementation detail or local limit | `const` | The consuming module |
| Public type-only finite domain | String-literal union | The owning domain's `types.ts` or `errors.ts` |
| Public finite domain also enumerated or mapped at runtime | `as const` object plus a derived value union | The owning domain module |
| Externally required runtime enum object | String `enum`, with explicit values | The owning boundary module |
| Provider, HTTP, or user-supplied dynamic value | `string` or `unknown`, followed by boundary validation | The adapter or parser boundary |

The `as const` form preserves literal value types and makes the runtime mapping
explicit without adding a TypeScript-only runtime construct. Prefer it over an
`enum` for new Muse-owned runtime identifiers. A regular string `enum` is
appropriate only when callers genuinely require an emitted named object or an
external contract prescribes one. Never use numeric or heterogeneous enums for
serialized values.

Do not introduce `const enum` into a published workspace contract. TypeScript
documents compatibility pitfalls for ambient `const enum` declarations with
`isolatedModules`, version skew, and runtime imports. A local performance
micro-optimization is not sufficient justification in this multi-package
workspace.

Keep constants with their ownership boundary. A global constants module is
prohibited: it obscures domain ownership and turns accidental reuse into a
cross-package contract. Move a value to `@muse/shared` only after at least two
independent packages need the same foundational runtime contract; otherwise
keep it in its domain package.

## Sources and verification

- Official TypeScript 6 release notes, "Preparing for TypeScript 7.0":
  https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html
- TypeScript Handbook, "Enums" and "Objects vs Enums":
  https://www.typescriptlang.org/docs/handbook/enums.html
- TypeScript 3.4 release notes, "const assertions":
  https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-4.html
- typescript-eslint `no-duplicate-enum-values` rule:
  https://typescript-eslint.io/rules/no-duplicate-enum-values/
- `pnpm --filter @muse/web build`
