---
title: TS7 Toolchain Policy
status: active
updated: 2026-07-15
---

# TS7 Toolchain Policy

Muse now uses a **two-package TypeScript setup**:

- `@typescript/native` is the build compiler (`tsc`), driven by TS 7.
- `typescript` stays on TS 6 compatibility package (`npm:@typescript/typescript6`) for tools that import `typescript` directly (ESLint/knip stack).

## Build and typecheck contract

- `build` target runs: `pnpm run build:ts7-fast`
- `typecheck` target runs: `pnpm run typecheck:ts7-fast` then `@muse/web` typecheck
- Both `build:ts7-fast` and `typecheck:ts7-fast` are thin wrappers around `scripts/run-tsc-fast.mjs`.
- `build:ts7-single-thread` and `typecheck:ts7-single-thread` keep the same contract and force `--single-threaded`.
- Shared policy is declared in `scripts/tsc-fast-flags.mjs`.

## Runner contract

- Supported modes: `build`, `typecheck`
- `build` defaults to incremental project-graph parallelism and emits outputs.
- `typecheck` defaults to incremental + `--noEmit`.
- Single-threaded mode is `--single-threaded` and intentionally omits project-graph flags.

## Parallelism policy

`TS7_PARALLELISM` controls the default project-graph worker count when set.

- Clamped to `[1, 8]`.
- Empty / invalid values fall back to `1`.
- Unset value defaults to CPU parallelism, bounded to `[1, 8]`.

Example:

```bash
TS7_PARALLELISM=4 pnpm run build:ts7-fast
```

You can enable lightweight profiling logs for the runner:

```bash
TS7_TSC_FAST_PROFILE=1 pnpm run build:ts7-fast
```

The output prints one line when enabled:

```text
tsc-fast profile: mode=build threadMode=parallel elapsedMs=1234
```

You can also set a performance threshold to surface regressions:

```bash
TS7_TSC_FAST_SLOW_MS=15000 pnpm run typecheck:ts7-fast
```

If a run exceeds the threshold, it prints:

```text
tsc-fast perf alert: elapsedMs=15234 exceeded threshold 15000ms
```

`TS7_TSC_FAST_SLOW_MS` still prints the same profile line, so you can combine it with
`TS7_TSC_FAST_PROFILE=1` if you want explicit on/off toggles during investigation.

## Gate checks

Use:

```bash
pnpm run check:ts7
pnpm run check:tsconfig
pnpm run check:toolchain   # aliases check:ts7 + check:tsconfig
pnpm run check             # check:toolchain then build + test
```

The checks validate:

- TS7/TS6 split remains intact.
- Root scripts follow the shared command contract.
- `tsconfig.json` graph options remain aligned with `tsconfig.base.json`.
