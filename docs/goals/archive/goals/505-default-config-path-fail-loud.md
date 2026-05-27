# 505 — `defaultConfigPath` fails loud on empty `HOME=` (goal-495 sibling on the CLI's first read every command does)

## Why

`apps/cli/src/program-helpers.ts:58` exported the foundational
config-path resolver every CLI command consumes — `muse chat`,
`muse status`, `muse config get/set`, `muse persona`, `muse
remember`, `muse trust`, `muse approval`, `muse jobs`, `muse
actions`, … all read from `~/.config/muse/config.json` via
`defaultConfigPath()`. Pre-fix:

```ts
export function defaultConfigPath(home = process.env.HOME ?? "~"): string {
  return path.join(home, ".config", "muse", "config.json");
}
```

Two empty-env-shadow defects on the most central CLI startup path:

- **`HOME=""`** (the pre-cleared-env launcher pattern):
  `"" ?? "~"` → `""` → `path.join("", ".config", "muse",
  "config.json")` → `".config/muse/config.json"` — a **relative
  path under the current working directory**. The CLI silently
  writes config under wherever the user happened to invoke it
  from, indistinguishable from a missing config (a fresh load
  the next directory the user `cd`s into). Worse: with
  `HOME=""` the credential store and the config store land in
  different directories — half-configured CLI.
- **`HOME=undefined`**: `undefined ?? "~"` → `"~"` → `path.join(
  "~", …)` → `"~/.config/muse/config.json"` — a **literal `~`
  directory**, since `path.join` does not expand tildes. The
  CLI creates a directory named `~` in CWD on first config
  write.

Same empty-env-shadow defect class as goals 478/481/482/483/488/
495/503 — here on the analogous sibling to the goal-495
`defaultCredentialPath` that was already hardened.

The fix mirrors goal 495's `defaultCredentialPath` byte-for-byte
(trim → explicit → `process.env.HOME?.trim()` → `homedir().trim()`
→ throw). After this iteration both the credentials store and the
config store share one fail-loud-on-empty-HOME contract; the CLI's
two foundational filesystem boundaries no longer drift.

## Slice

- `apps/cli/src/program-helpers.ts` — `defaultConfigPath`
  rewritten to mirror `defaultCredentialPath`: trim explicit
  param → `process.env.HOME?.trim()` → `homedir().trim()` → throw
  on triple-empty. Added `import { homedir } from "node:os"` at
  the top alongside the existing `node:fs/promises`/`node:path`
  imports.
- `apps/cli/src/program-helpers.test.ts` — new file, 4 focused
  tests covering the same matrix the goal-495 test pins on
  `defaultCredentialPath`:
  - HOME set → rooted under `~/.config/muse/config.json`.
  - explicit non-empty param (trimmed) overrides HOME.
  - explicit empty / whitespace-only param falls through to HOME.
  - `HOME=""` + `os.homedir()` empty MUST throw with a clear
    message (NOT silently fall back to `/.config/muse/...` at
    the filesystem root or to CWD); the platform-conditional
    branch tolerates a real `homedir()` providing a fallback.

Behaviour byte-identical for every clean `HOME=/u/foo` env — only
the pre-cleared / undefined paths change from silent-relative-path
to fail-loud.

## Verify

- New test 4/4 green; full `@muse/cli` suite green (839 passed,
  +4 vs baseline 835, 0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the helper
  to the prior `process.env.HOME ?? "~"` default-arg + bare
  `path.join` produces 3 RED tests with the precise pre-fix
  symptoms:
  - explicit-non-empty trim assertion fails
    (`"  /trimmed  /.config/muse/config.json"` — no trim applied)
  - `HOME=""` falls through to `.config/muse/config.json`
    (relative path under CWD, not absolute under home)
  - the `Cannot resolve home directory` throw never fires
    Restored byte-identical; suite back to 4 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint` 0/0;
  `pnpm guard:core` clean (no IMMUTABLE-CORE touched); byte-scan
  clean; `git status` shows only the two intended files.
- Pure path resolver — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-loop
  Step 9).

## Status

Done. The CLI's foundational config path resolver no longer
silently writes config under CWD when `HOME=""`, and no longer
creates a literal `~` directory when `HOME` is undefined. The two
filesystem-boundary helpers in the CLI (`defaultCredentialPath`
from goal 495 + `defaultConfigPath` from this iteration) now share
one consistent fail-loud-on-empty-HOME contract — no asymmetry left
for a future regression to widen.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an empty-env-shadow sibling-asymmetry
`fix:` on the CLI's most central startup path, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Mirrored goal 495's `defaultCredentialPath` byte-for-byte rather
  than building a one-off variant: the cross-helper convention
  must read identically — a near-variant after one consistent fix
  would be the drift the convention exists to prevent. The test
  file uses the same 4-test matrix from `credential-store.test.ts`
  for the same reason.
- Threw a distinct error message (`config.json` rather than
  `credentials.json`) so the operator sees which resolver fired,
  not just that "the home directory is empty".
- Did NOT change the `defaultConfigPath` parameter from
  `home: string = "..."` to `home?: string`'s call sites elsewhere
  in the codebase — `path.join`'s undefined-arg-rejection would
  surface immediately if a caller relied on the silent-empty
  default. Existing callers (`program.test.ts` line 48 calls
  `defaultConfigPath()` with no arg) continue to work since the
  no-arg path now reads `process.env.HOME` directly.
- The fail-loud throw on triple-empty is the same posture the
  iteration-loop Step 9 endorses: "if verification fails fix the
  root cause — never skip or weaken a check." A silent relative
  path or `/.config/muse/...` write is a check the foundational
  resolver should never let slip.
