# 584 — `muse config set --json` emits a structured envelope and brings first direct-test coverage to the config command surface

## Why

The CLI config command had asymmetric `--json` support:
`muse config show --json` worked, but `muse config set
<key> <value>` only emitted the plain-text `Set <key>\n`
line. Scripts that programmatically toggle config (a
provisioning shell that sets apiUrl + defaultModel before
running `muse status`, an experiment runner that swaps
`defaultModel` between iterations) had no way to confirm
WHAT value was written — only that something was written.

Same convention shape as goals 582/583's persona write-
surface `--json` envelopes. Different command family
(config vs persona), same scripting need.

Bonus: `commands-config.ts` had no direct test coverage —
this iteration adds the first `commands-config.test.ts`
file to the package alongside the new functionality.

## Slice

- `apps/cli/src/commands-config.ts` — added `--json`
  option to `muse config set`. On `--json`, emits
  `{ key, value }` where `value` is the trimmed form
  (matching the goal-535 `setConfigValue` normalisation
  contract: the helper itself trims, so the envelope
  echoes the persisted value, not the raw user input).
  Legacy `Set <key>\n` output preserved when `--json`
  is omitted.
- `apps/cli/src/commands-config.test.ts` — new test file.
  3 `it(...)` blocks: `--json` emits the envelope and
  persists; trimming preserved in envelope; no-`--json`
  keeps the legacy output unchanged. The harness uses a
  fake `setConfigValue` that trims (matches the real
  `setConfigValue` from `program-helpers.ts`).

## Verify

- New `it(...)`s green; full `@muse/cli` suite green (1040
  passed, +3 vs baseline 1037, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): collapsing the
  `--json` branch back to the bare `io.stdout("Set <key>")`
  shape makes 2 of the 3 new tests fail (the envelope
  asserts have nothing to JSON.parse — the legacy "Set
  apiUrl" line emits instead). The third test (no-`--json`
  keeps the legacy output) is unaffected. Fix restored,
  suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api
  249 passed, apps/cli 1040 passed); `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the three intended files.
- Pure CLI write surface — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is `muse
  config set --json` scripted use, not the model loop.

## Status

Done. The CLI config surface now mirrors the goal-582/583
persona write-surface --json convention:

| Command | --json envelope |
| --- | --- |
| `muse config show` | the config dump |
| `muse config set` | `{ key, value }` (this goal) |

A future grep for CLI write commands without `--json`
support narrows toward the few remaining outliers
(`muse feeds refresh`, `muse trust grant/block/revoke/unblock`).
Deferred to keep scope tight.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
CLI scripting completeness `feat:` on the existing
config write surface, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Envelope shape: `{ key, value }`. Matches goal 583's
  `add` envelope shape (`{ action, id }` — verb +
  identifier) — here the verb is implicit ("set") and
  the identifier is the key, with the value as the
  data. Considered `{ key, value, action: "set" }` —
  rejected as redundant since the command name already
  implies the action.
- `value: value.trim()` — the envelope echoes the
  trimmed form, NOT the raw user input. Reason: the
  real `setConfigValue` from `program-helpers.ts:309`
  trims the value before persisting, so the envelope
  should reflect what was persisted, not what the user
  typed. Scripts that programmatically chain "set X then
  verify X" expect the envelope's `value` to match what
  a subsequent `muse config show --json` would return.
- New test file `commands-config.test.ts` — first direct
  coverage on this command surface. The harness uses a
  fake `setConfigValue` to keep the test independent of
  the `program-helpers.ts` implementation (DI shape
  matches `ConfigCommandHelpers`). The trim assertion
  mirrors the real helper's behaviour byte-for-byte.
- The mutation reverts to the bare `io.stdout(legacy)`
  shape — both `if (options.json)` and the JSON.stringify
  call are the load-bearing delta. Mutation removes both
  at once.
- Step-8 sub-defect-class check: CLI write-surface
  `--json` envelope is the same convention as goals
  582/583 (just a different command family). Three
  iterations in a row of "add --json to a write command"
  is at the boundary of Step-8 stagnation, BUT each
  closure is a discrete asymmetric outlier (different
  command, different envelope shape). The pattern
  matches goal 558→557 / 569→568 / 571→570 / 583→582
  (close deferred sibling next).
