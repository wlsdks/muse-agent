# 103 — `muse memory` honours `--persona` / `MUSE_PERSONA`

## Why

Goal 097 made every persona-aware subcommand (`brief`, `remember`,
`ask`, `trust`, `approval`, `job run`) honour `--persona` /
`MUSE_PERSONA` so a single user (`stark`) can hold distinct
`stark@work` / `stark@home` records in the on-disk store.

`muse memory show / set / diff / clear` was the lone outlier — it
kept reading and writing the bare `<user>` record. A user with
`export MUSE_PERSONA=work` in their shell-rc could not inspect or
edit their work-slot memory through the dedicated `muse memory`
group; they had to drop the env, run, restore — or worse, lose the
slot edit to the wrong record entirely.

## Scope

- `apps/cli/src/commands-memory.ts`:
  - `resolveMemoryUserId(explicit, personaOption?)` now composes
    `<base>@<slot>` via the goal-097 `resolvePersona` helper
    (option > `MUSE_PERSONA` env > none). Exported so direct
    tests don't need to round-trip through the CLI.
  - `--persona <slot>` option added to every memory subcommand
    (`show`, `set`, `diff`, `clear`); each action threads
    `options.persona` into `resolveMemoryUserId`.
- No on-disk schema change. The `<user>@<slot>` keys were already
  the contract; this iteration just exposes them through the
  `memory` group.

## Verify

- New cases in `apps/cli/test/program.test.ts`:
  - Helper-level: explicit option wins, env fills the gap, no slot
    → bare userId.
  - End-to-end: `MUSE_PERSONA=work muse memory show` hits
    `/api/user-memory/stark@work`; explicit `--persona home`
    overrides the env and hits `/stark@home`.
- `pnpm --filter @muse/cli test` — 320 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — the memory group now keys consistently with the rest of
the persona-aware CLI. A `MUSE_PERSONA=work muse memory diff`
shows only the work slot's drift.
