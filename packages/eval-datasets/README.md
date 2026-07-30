# @muse/eval-datasets

Generates and validates large synthetic evaluation corpora under a fixed provenance contract:
every record is tagged `dataOrigin: "synthetic"`, `organicEvidence: false`, and
`personalLearningEligible: false`, so a generated corpus can never be silently promoted to
"organic" or "personal-learning" evidence downstream (see `../../.claude/rules/verification/agent-testing.md`'s
evaluation-accounting vocabulary).

## Public surface

- `.` (`src/index.ts`, plus `eval-dataset-contract.js`/`eval-dataset-generate.js`) —
  `generateTier` (writes a tier's records + manifest under `.muse-dev/eval-data/`),
  `validateTier` (streams and re-validates a generated tier: schema, byte/hash digest, the
  balanced 96-cell family/locale/complexity matrix, and record-level collisions via
  `CollisionDatabase`), `assertManifest`/`assertExactKeys`, `resolveSafeEvalPath` (path
  containment + symlink rejection), `ownerMuseManifest`, and the record/manifest contract types
  (`EvalRecord`, `TierManifest`, `Family`, `Tier`, `FAMILIES`, `TIERS`, `SCHEMA_VERSION`,
  `GENERATOR_VERSION`).

## Depends on

- `@muse/attunement`, `@muse/memory`, `@muse/policy`, `@muse/recall` — declared workspace
  dependencies of the eval-dataset generator/contract, per `package.json`.

## Rules that bind this package

- Generated/validated/sampled corpus artifacts prove corpus integrity, not agent PASS — per
  `../../.claude/rules/verification/agent-testing.md`'s evaluation-accounting vocabulary, never relabel a
  generated count as executed or agent-passed signal.
- Output paths are hard-confined to `.muse-dev/eval-data/` and every write is size/RSS/time
  capped (`resolveSafeEvalPath`, the 1.5 GiB/512 MiB/five-minute ceilings in `generateTier`) —
  this is untrusted-scale generation code and treats its own output path as such.

## Tests

`pnpm --filter @muse/eval-datasets test`
