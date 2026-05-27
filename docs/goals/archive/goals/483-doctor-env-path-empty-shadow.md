# 483 — `muse doctor` no longer reports `~/.muse` + `mcp.json` as missing when `MUSE_HOME=` / `MUSE_MCP_CONFIG=` is set empty (goal-478/481/482 sibling)

## Why

Continuation of the systematic goal-478/481/482 grep for
`process.env.X ?? default` empty-shadow patterns. `muse doctor`
— the user's go-to *diagnostic* surface, the thing they run
when something feels wrong — had two of them on the most
high-trust path:

- `apps/cli/src/commands-doctor.ts:195` —
  `const muse_home = process.env.MUSE_HOME ?? join(homedir(), ".muse")`
- `apps/cli/src/commands-doctor.ts:208` —
  `const mcp_path = process.env.MUSE_MCP_CONFIG ?? join(muse_home, "mcp.json")`

`??` only falls back on `null`/`undefined`, so a shell that
pre-clears `MUSE_HOME=` ("zero out leaked env" pattern) left
`muse_home = ""`, `fs.stat("")` threw, and the doctor reported
`~/.muse` as **missing — first run hasn't seeded it yet**. Then
the doctor walked the rest of its checks rooted at `""` —
`mcp.json` reported missing, every subsequent path-rooted check
likewise. The diagnostic surface gave the user a **completely
wrong picture** of their actually-correct setup.

Particularly bad UX: doctor is the recovery tool. A doctor that
lies when env is empty silently sends the user chasing problems
that don't exist.

## Slice

- `apps/cli/src/commands-doctor.ts` — new exported helper
  `resolveMuseEnvPath(raw, fallback)`: returns the fallback
  when `raw` is undefined OR an empty/whitespace-only string;
  trims surrounding whitespace; otherwise returns the env
  value. Same semantics as `resolveDefaultUserKey` (goal 482)
  and `resolveOllamaUrl` (goal 477) — single cross-CLI
  convention. Used at lines 195 and 208 to resolve `muse_home`
  and `mcp_path`. Behaviour byte-identical for every previously
  non-empty env value; only the empty-shadow path is closed.
- `apps/cli/src/commands-doctor.test.ts` — extended (existing 18
  tests untouched) with a focused `resolveMuseEnvPath` describe:
  undefined → fallback; non-empty value used; whitespace
  trimmed; empty/whitespace-only treated as unset.

## Verify

- New 4 tests green; the 18 pre-existing doctor tests still
  green (no wrong premise — no test asserted the message text
  for the missing-home/mcp.json case); full `@muse/cli` suite
  green (780 passed/0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the helper
  to `return raw ?? fallback` makes the new tests fail with
  the precise pre-fix symptoms (`expected '  /custom/muse-home  '
  to be '/custom/muse-home'` — whitespace not trimmed;
  `expected '' to be '/home/u/.muse'` — empty env shadows the
  default) while the other 17 tests stay green; fix restored,
  suite back to 19 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure path-resolution logic — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. A user who `export MUSE_HOME=` (or any launcher that
pre-clears it) no longer sees `muse doctor` falsely report the
home as missing and every subsequent `~/.muse`-rooted check
fail. Same defect class as goals 478 / 481 / 482; the
goal-478-and-following empty-env-shadow rollout now covers the
diagnostic CLI's path-from-env reads.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a correctness `fix:` discharging the
remaining doctor-surface siblings of the goal-478 defect class,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Added the helper as a per-file exported function
  (`resolveMuseEnvPath` in `commands-doctor.ts`) rather than a
  new `env-path.ts` module: only two callers in one file, and
  the test surface is co-located in the existing
  `commands-doctor.test.ts`. If a third caller appears, lift
  it to a shared module then.
- Mirrored the trim + empty-as-unset semantics from goals 477
  (`resolveOllamaUrl`) and 482 (`resolveDefaultUserKey`)
  verbatim — single cross-CLI convention; a near-variant after
  two consistent precedents is exactly the drift the
  single-pattern rollout exists to prevent.
- Did not also rewrite the `process.env.MUSE_SEARXNG_URL?.trim()`
  block at line 283 — it already correctly guards with
  `searxng_url && searxng_url.length > 0`, so it is not a
  member of this defect class.
