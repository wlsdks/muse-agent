# 535 — `muse config set <key>` adds a `did-you-mean` hint and enumerates supported keys on a typo (CLI UX polish + first direct coverage)

## Why

`apps/cli/src/program-helpers.ts:306` validated the
`muse config set <key> <value>` arg pair, throwing on a bad
key:

```ts
throw new Error(`Unsupported config key: ${key}`);
```

The error message doesn't tell the operator:
- which keys ARE supported (they have to read the source or
  remember `apiUrl` / `defaultModel`), or
- which one they probably meant (a typo like `apirurl` or
  `deafultModel` is a one-edit-distance away from a real key
  and could be suggested).

Same did-you-mean convention as goals 153 (feeds remove/refresh
typo), 414 (objectives kind), `commands-orchestrate.ts:51-54`
(mode typo), `commands-actions.ts:23-29` (result filter), and
several others. The `muse config set` command was the
remaining outlier on the CLI typo-hint convention.

Additionally, `setConfigValue` had **zero direct test
coverage** — no fixture pinned the supported-keys list, the
trim semantics, or the empty-value rejection.

## Slice

- `apps/cli/src/program-helpers.ts` — imported the existing
  `closestCommandName` helper and exposed a `const
  SUPPORTED_CONFIG_KEYS = ["apiUrl", "defaultModel"] as
  const` table. The throw at the bottom of `setConfigValue`
  now reads:
  ```ts
  const suggestion = closestCommandName(key, SUPPORTED_CONFIG_KEYS);
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`Unsupported config key '${key}' (expected one of: ${SUPPORTED_CONFIG_KEYS.join(", ")})${hint}`);
  ```
  Behaviour byte-identical for every clean `apiUrl` /
  `defaultModel` invocation. Only the error path changes: a
  typo now gets both the explicit options list AND the closest-
  match hint.
- `apps/cli/src/program-helpers.test.ts` — added one new
  `describe(...)` block with 4 focused tests:
  - happy path: both supported keys accept a trimmed value
  - empty-value rejection
  - typo with a near-miss → `did you mean '<key>'` hint
  - typo with nothing close → enumeration only, no random
    `did you mean` clause

## Verify

- New tests 4/4 green; full `@muse/cli` suite green (909
  passed, +6 vs baseline 903, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  throw to the pre-fix `throw new Error(\`Unsupported config
  key: ${key}\`);` makes the typo-hint test fail with the
  precise pre-fix symptom — `expected [Function] to throw
  error matching /Unsupported config key 'apirurl'.*ex…/u but
  got 'Unsupported config key: apirurl'`. Every other test
  stays green. Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI error-message helper — no LLM request-response
  wire path; `smoke:live` does not apply (per `testing.md`
  / iteration-loop Step 9). The defended path is the
  `muse config set` error surface, not the model loop.

## Status

Done. `muse config set apirurl http://x` now produces:

```
Unsupported config key 'apirurl' (expected one of: apiUrl, defaultModel) — did you mean 'apiUrl'?
```

…instead of the opaque `Unsupported config key: apirurl`.
The cross-CLI typo-hint convention now covers the config
key boundary alongside the other enum-style flags
(`--mode`, `--result`, `--kind`, `--status`, feed ids).

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a CLI-ergonomics polish +
first-coverage `fix:` on `setConfigValue`, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the empty-array truthy-leak (534) and
  tiebreaker run (533) to a CLI UX polish on a fresh
  surface (`muse config set` typo hint). Productive
  variation, not same-area churn.
- Reused the existing `closestCommandName` from `./closest-
  command.js` rather than introducing a new helper: the
  cross-CLI convention is established. Adding `did-you-mean`
  to one more enum-style boundary mirrors the same shape as
  goals 153 / 414 / 468 / 486 / 493 / 494 byte-for-byte.
- Extracted `SUPPORTED_CONFIG_KEYS` as a `const ... as const`
  table at module scope: the test file pins the exact list,
  and future config keys (e.g. `voice.engine`,
  `notes.indexInterval`) can be added by amending the table
  in one place. Pre-fix the supported keys were implicit in
  two `if (key === "...")` branches; this makes the list
  declarative.
- The error message format follows the convention from
  `commands-orchestrate.ts:54`:
  `<flag> must be one of: X, Y (got 'Z') — did you mean 'X'?`.
  Same shape, same readability.
- Did NOT add tests through the Commander harness (like
  `commands-orchestrate.test.ts`): `setConfigValue` is a
  pure function — testing it directly is the narrowest
  approach. The Commander dispatch is byte-identical to
  every other `command.action()` call.
- The mutation reverts just the 3-line throw block to its
  pre-fix shape; the test failure
  (`'Unsupported config key: apirurl'` vs.
  `Unsupported config key 'apirurl'.*did you mean 'apiUrl'`)
  reproduces the pre-fix observable byte-for-byte.
