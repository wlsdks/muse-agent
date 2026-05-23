# Goal 888 — `muse config unset <key>` reverts a config value to the default

## Outward change

`muse config unset apiUrl` (or `defaultModel`) clears that key from
`~/.config/muse/config.json` so it reverts to the built-in default —
`set`'s missing inverse. Until now a user who pointed `apiUrl` at a
remote server and wanted to go back to the local default had to
hand-edit the JSON file; there was no CLI verb to clear a value.
`unset` reports `Unset <key>` when a value was cleared and `<key>
was not set` on a no-op, refuses an unknown key with the same
`did you mean` hint as `set`, and emits a `{ key, wasSet }` envelope
under `--json`.

## Why this, now

`muse config` had `show` + `set` but no `unset` — a CRUD-completeness
seam (the same class as the recent calendar/objectives/notes
delete-verb fills). Reverting a wrong `apiUrl` to the local default
is a real recovery path with no non-JSON-editing way to do it. A
small, verifiable correctness/UX gap on a fresh, not-recently-touched
surface.

## How

- `unsetConfigValue(config, key)` in `program-helpers.ts`: same key
  validation as `setConfigValue` (unknown → throw with closest-match
  hint), then omits the key via rest-destructuring (the config type's
  fields are `readonly`, so `delete` won't compile). Returns
  `{ config, wasSet }` so the caller distinguishes a real clear from
  a no-op.
- `muse config unset <key>` subcommand wired through the existing
  `ConfigCommandHelpers` DI seam; registered in `program.ts`.

## Verification

- `apps/cli` `program-helpers.test.ts`: `unsetConfigValue` clears a
  set key (`wasSet: true`, other key intact), no-ops a never-set key
  (`wasSet: false`), and rejects an unknown key with the `did you
  mean` hint.
- `apps/cli` `commands-config.test.ts`: drives the real
  `unsetConfigValue` through the command — `set` then `unset` removes
  the key from the store and prints `Unset apiUrl`; unset of a
  never-set key prints `was not set`; `--json` emits
  `{ key, wasSet }`.
- Mutation-proven: forcing `wasSet = true` fails the no-op cases.
  No LLM path → no smoke:live; Ollama down regardless. `pnpm check`
  exit 0, `pnpm lint` 0/0.

## Decisions

- Rest-destructuring omit (`const { [key]: _removed, ...rest }`)
  rather than `delete` — `MuseCliConfig` fields are `readonly` and
  `delete` on a readonly property is a type error.
- The command-level test wires the REAL `unsetConfigValue` (not a
  fake) into the harness so it exercises the actual omit + validation
  logic end-to-end, not a happy-path stub.
