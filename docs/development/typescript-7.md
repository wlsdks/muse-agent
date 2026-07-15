# TypeScript 7 toolchain

**Status:** TS7 compiler adopted; migration hardening in progress as of
2026-07-15. This document records the supported Muse toolchain and the
migration rules for TypeScript 7 (TS7).

## Supported split

Muse uses the TS7 native compiler for project builds. `pnpm exec tsc` therefore
runs the `@typescript/native` package. The root `typescript` dependency is
intentionally aliased to Microsoft's `@typescript/typescript6` compatibility
package so compiler-API consumers, including typescript-eslint, keep a stable
TS6 API until the TS7 API is declared stable.

This is the side-by-side setup recommended in the official TS7 announcement:
TS7 for compilation, TS6 for API consumers. It is not a partial migration and
must not be "simplified" by making `typescript` point at TS7. Re-evaluate the
alias only when the relevant tools explicitly support the stable TS7 API.

## Commands

```bash
# Normal TS7 project-reference build/typecheck.
pnpm typecheck:fast

# TS7 parallel checker/builder measurement; same diagnostics, different scheduling.
pnpm typecheck:ts7-fast

# Compatibility compiler, only for an explicit tool-API investigation.
pnpm exec tsc6 --version
```

Start migration work with `pnpm typecheck:fast`, classify the compiler output,
and then run the narrow package build and behavior tests for each repaired
boundary. Do not substitute a repository-wide test fan-out for compiler
diagnostics. A full `pnpm check` remains the release gate once the TS7 graph is
clean.

## Migration rules

1. Keep every workspace dependency that provides runtime types as a matching
   TypeScript project reference. A declaration package that is absent from the
   reference graph can make otherwise-valid imports appear missing.
2. Preserve genuine type predicates at untrusted JSON boundaries. A parser
   predicate must be typed `(value: unknown) => value is T`; returning `T |
   undefined` does not narrow `unknown` and hides a fail-closed validation
   defect.
3. Repair shared contracts before callers. A broken shared export or import can
   create dozens of downstream `unknown` and missing-export diagnostics.
4. Do not restore legacy behavior by setting `ignoreDeprecations`, lowering
   `strict`, or retaining removed module-resolution/emit options. TS7 removes
   legacy modes such as ES5 target, `moduleResolution: node`/`classic`, and
   import assertions; choose a current Node or bundler resolution strategy at
   the owning package boundary instead.
5. Keep `types` explicit and project roots deterministic. TS7 defaults are
   intentionally stricter around type acquisition and project layout.

## Verification order

1. `pnpm typecheck:fast`
2. `pnpm --filter @muse/<affected-package> build`
3. The narrow behavior tests that cover the changed contract
4. `pnpm build` and the required release checks only after the graph is clean

The parallel checker flags (`--checkers`, `--builders`) affect scheduling and
performance, not type-safety semantics. `--singleThreaded` is reserved for
diagnosing a native-compiler concurrency issue; it is not a compatibility
fallback.

## Official references

- [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [TypeScript 7.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-7-0.html)
- [TypeScript compiler options](https://www.typescriptlang.org/tsconfig/)
