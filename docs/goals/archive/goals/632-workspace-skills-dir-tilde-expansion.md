# 632 — `resolveWorkspaceSkillsDir` runs the env override through `expandLeadingTilde` like every sibling path resolver in the same file, so `MUSE_WORKSPACE_SKILLS_DIR=~/work/skills` doesn't land literally and silently make the user's workspace skills invisible to the loader

## Why

`packages/autoconfigure/src/provider-paths.ts` defines a private
`expandLeadingTilde(p)` helper that the shared resolver
`resolveDotMusePath` calls on every env override before returning
it. The reason is documented inline:

```ts
// A `MUSE_*` path override commonly carries a leading `~` (docs
// show `~/.muse/...`; systemd `Environment=`, Docker `-e`, .env
// files, and quoted shell assignments do NOT expand it, and Node
// never does). Without this the value lands literally and state
// is written into a bogus `./~/` directory.
```

Every personal-domain resolver in the file
(`resolveTasksFile`, `resolveNotesDir`, `resolveRemindersFile`,
`resolveLocalCalendarFile`, the messaging cursor / inbox
sidecars, the model-keys file, etc.) routes through
`resolveDotMusePath` and inherits the tilde expansion.

**`resolveWorkspaceSkillsDir` is the lone exception.** Pre-fix:

```ts
export function resolveWorkspaceSkillsDir(env: MuseEnvironment): string | undefined {
  const override = env.MUSE_WORKSPACE_SKILLS_DIR?.trim();
  return override && override.length > 0 ? override : undefined;
}
```

It's the only resolver in the file that handles its env override
inline (because its semantics are "undefined when unset", not
"fallback to ~/.muse"). Inlining the trim+empty check is fine —
but it ALSO inlined the bypass of `expandLeadingTilde`.

User-visible impact: an operator who reads the docs
(`docs/design/skills.md`, README, every other `MUSE_*` env var)
naturally writes `MUSE_WORKSPACE_SKILLS_DIR=~/work/skills` in
their `.muse.env` / systemd unit / docker-compose / shell
profile. None of those expansion contexts handle the tilde —
the literal `~/work/skills` reaches the resolver verbatim, gets
returned verbatim, and lands in `FileSystemSkillLoader({ roots:
[..., { path: "~/work/skills", source: "workspace" }] })` at
`personal-providers.ts:227`. The loader does a `readdir` on the
literal path. Result: `ENOENT: no such file or directory,
scandir '~/work/skills'`.

But — the loader catches per-root errors fail-open (the lifecycle
gates `FileSystemSkillLoader.loadAll` with try/catch per root,
since one missing user-skills dir shouldn't break the system-
skills load). So the workspace skills are **silently invisible**
— no error, no warning, no fallback. The user thinks the
workspace skill they wrote is just buggy, with no debugging trail
to the path-expansion issue.

This iter's defect class — **env-driven path resolver missing
the sibling helper's tilde expansion** — is fresh against the
recent window:

- 631: concurrent file-rewrites serialization
- 630: mkdtemp directory cleanup
- 629: per-entry validation
- 628: unit-promotion + finite-guard
- 627: tolerant-read nested array
- 626: child-process stream error
- 625: strict env-parse
- 624: HTTP timeout
- 623: classification
- 622: boolean spelling

Path-expansion / sibling-parity in env-derived paths hasn't been
hit. Closest sibling is 478/481/482 (CLI env-trimming) referenced
in `commands-doctor.test.ts:140`, but those are about
whitespace, not tilde expansion.

## Slice

- `packages/autoconfigure/src/provider-paths.ts:resolveWorkspaceSkillsDir`:
  - One-line change: route the override through `expandLeadingTilde`
    before returning. `expandLeadingTilde` is already file-local
    and already exercised by every sibling resolver.
  - The fallback (return `undefined` when unset / blank) is
    unchanged — `resolveWorkspaceSkillsDir` deliberately doesn't
    fall back to `~/.muse/...` because the workspace skills are
    an optional, opt-in surface.
- `packages/autoconfigure/test/autoconfigure.test.ts`:
  - New import: `resolveWorkspaceSkillsDir` from
    `../src/provider-paths.js`. It's exported from
    `provider-paths.ts` but not re-exported from
    `autoconfigure/src/index.ts`, so the direct path import keeps
    the test scope tight without expanding the package's public
    surface.
  - One new test, seven assertions covering every meaningful
    branch:
    - `~/work/skills` → `${home}/work/skills` (the headline fix)
    - `~` alone → `${home}` (the "expand to home" form)
    - `/abs/skills` → unchanged (absolute paths pass through)
    - `~bob/skills` → unchanged (per-other-user tildes are
      left literal — the helper only expands the current-user
      forms `~` and `~/`)
    - `{}` → `undefined` (no env override, no fallback)
    - `""` → `undefined` (empty after trim)
    - `"   "` → `undefined` (whitespace-only)

## Verify

- `@muse/autoconfigure` suite green (147 passed, +1 vs the
  pre-iter baseline of 146, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the call
  back to a bare `override` return makes the new test fail with
  the EXACT pre-fix symptom: `expected '~/work/skills' to be
  '/Users/jinan/work/skills'`. The "received" value is the
  literal `~/work/skills` — the exact string `FileSystemSkillLoader`
  would have tried to readdir. The six other assertions in the
  test still pass pre-fix (absolute paths, `~bob/...`, undefined
  branches don't depend on tilde expansion); the one assertion
  that fails is exactly the headline fix.
- `pnpm check` green: apps/api 261/261, apps/cli 1093/1093,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean on
  both touched files.
- No LLM request/response wire path touched — pure env-string
  expansion. `smoke:live` doesn't apply.

## Status

Done. `MUSE_WORKSPACE_SKILLS_DIR` now behaves identically to
every other personal-domain `MUSE_*` path env var:

| `MUSE_WORKSPACE_SKILLS_DIR` value | Before                    | After                       |
| --------------------------------- | ------------------------- | --------------------------- |
| `/abs/skills`                     | `/abs/skills`             | unchanged                   |
| `~/work/skills`                   | **`~/work/skills` literal** | `${home}/work/skills` (**fixed**) |
| `~` alone                         | **`~` literal**            | `${home}` (**fixed**)       |
| `~bob/skills`                     | `~bob/skills`             | unchanged (per-user tildes stay literal) |
| unset / `""` / `"   "`            | `undefined`               | unchanged                   |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a sibling-
parity / robustness `fix:` on an env-driven path resolver.
Recorded with this backlog row.

## Decisions

- **Reused the file-local `expandLeadingTilde`, didn't
  duplicate the logic.** The helper is in scope already; no
  refactor needed. Three lines of "if it starts with ~/...,
  join with homedir" inlined would have drifted from
  `resolveDotMusePath`'s implementation if either evolves.
- **Did NOT promote `expandLeadingTilde` to a public export.**
  No external caller needs it. Future resolvers that need
  tilde expansion should go through `resolveDotMusePath`
  (`resolveDotMusePath` IS the public contract for env-driven
  paths in the file).
- **Test imports `resolveWorkspaceSkillsDir` from
  `../src/provider-paths.js`**, not from
  `../src/index.js` (it's not re-exported there). Keeps the
  test scope narrow without expanding the package's public
  surface. The `personal-providers.ts` re-export at line 78
  IS the consumer-facing path — but `personal-providers` and
  `provider-paths` are both internal to the package, so the
  direct import is equally legitimate.
- **Did NOT also `expandLeadingTilde` on the CLI side**
  (`apps/cli/src/feeds-store.ts:defaultFeedsFile`,
  `apps/cli/src/persona-store.ts:defaultPersonaFile`,
  `apps/cli/src/episode-index.ts:defaultEpisodeIndexFile`,
  etc.). Those have the same defect class but are CLI-internal
  and warrant their own audit — each has its own tilde
  expansion need. Scope-limited to the autoconfigure sibling
  that was the obvious miss.
- **Mutation choice.** Reverted only the
  `expandLeadingTilde(override)` call — exactly the line a
  maintainer might revert thinking "this resolver is simple,
  no expansion needed." One test assertion fails with the
  exact pre-fix symptom (the literal `~/work/skills` returned
  unchanged); the other six pass both pre- and post-fix
  because they exercise non-tilde paths. Confirms the fix is
  surgical and the test set pins exactly what changed.

## Remaining risks

- **CLI-side resolvers with the same pattern.** A quick grep
  shows ~15 places under `apps/cli/src/` that read
  `process.env.MUSE_*?.trim()` and return the value verbatim
  (e.g. `feeds-store.ts:47`, `persona-store.ts:73`,
  `episode-index.ts:43`, `commands-recall.ts:43`,
  `commands-session.ts:39`, `commands-approval.ts:45/49`,
  `commands-trust.ts:46`, `commands-export.ts:71`,
  `commands-routine.ts:45`, `jwt-rotation-store.ts:46`,
  `commands-jobs.ts:76`, `commands-doctor.ts:225/238`,
  `commands-setup-voice.ts:61`). Each has the same defect
  class. Per-iter fix or a CLI-wide helper extraction would
  close the gap. Out-of-scope for this single sibling fix.
- **`~user`** (per-other-user tilde) is intentionally left
  literal. The `expandLeadingTilde` helper only expands the
  current-user forms `~` and `~/`. A user who actually wants
  to point Muse at another user's skills dir would use the
  resolved absolute path. Documented in the helper's existing
  comment.
- **`process.env.HOME` overrides.** `expandLeadingTilde` uses
  `homedir()`, which on POSIX consults `HOME` first.
  Operators who set `HOME` to a custom path get the expected
  expansion; operators who don't set `HOME` get the OS-level
  home. No surprise either way.
