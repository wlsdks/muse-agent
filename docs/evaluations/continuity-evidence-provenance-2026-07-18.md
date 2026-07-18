# Continuity evidence provenance evaluation — 2026-07-18

## Claim under test

Controlled or synthetic Continuity evidence must remain useful for engineering
verification without increasing product readiness. Production-authorized
readiness requires matching provenance on both sides of a durable pair:

- delivery `organic` + outcome `organic` for outcome readiness;
- delivery `organic` + interaction receipt `organic` for exact-interaction
  readiness.

`organic` means the write came through an allowlisted Muse production host
path. It does not certify natural timing, usefulness, causality, or permission.

## Implementation boundary

- Attunement schema 3 stores provenance independently on deliveries, outcomes,
  and interaction receipts. Interaction outbox schema 2 freezes it before task
  completion and preserves it across restart and retry.
- The ordinary `@muse/attunement` package surface cannot perform an organic
  write. Three exact operations live under `@muse/attunement/host`; a repository
  scanner and ESLint allow only the two API files, two CLI files, and one
  production loopback assembly file to import that seam.
- Schema 1/2 Attunement data and outbox 1 data normalize to `unclassified` in
  memory. Read-only access preserves the original bytes; the next mutation
  writes the new schema without changing prior IDs, order, timestamps, policy,
  or fingerprints.
- CLI and web separate production-authorized numeric readiness from an
  all-recorded technical digest. The recent-delivery web list is read-only;
  outcome writes use only the provenance-aware canonical review queue.

## Reproducible aggregate result

Run:

```bash
pnpm eval:continuity-provenance
```

The runner imports the production reducers, creates its corpus in memory, and
writes only the aggregate result under ignored
`.muse-dev/evals/continuity-provenance/result.json`.

| Metric | Result |
| --- | --- |
| Controlled deliveries | 10,080 |
| Controlled exact receipts | 10,080 |
| Controlled readiness deliveries / outcomes / exact interactions | 0 / 0 / 0 |
| Technical controlled deliveries / receipts / exact states | 10,080 / 10,080 / 10,080 |
| Ordinary-input classification attempts | 1,000 |
| Resulting organic / controlled / unclassified classes | 0 / 0 / 1,000 |
| Organic-producing names on the ordinary package surface | 0 |
| Actual Attunement/tasks/outbox state changed | no |

The classification attempts cover serialized objects, literal values, and the
ordinary package surface. They are classification checks, not claims that
1,000 durable records were written.

## Verification gates

| Check | Result |
| --- | --- |
| Independent high-risk focused set | PASS — 84/84, twice |
| Changed-file API tests | PASS — 239/239 |
| Changed-file CLI tests | PASS — 373/373 |
| Changed-file web unit tests | PASS — 196/196 |
| Chromium Browser Mode | PASS — 82/82 related after latest-main integration; 10/10 focused |
| Changed-file Attunement tests | PASS — 95/95 |
| Changed-file autoconfigure tests | PASS — 388/388 |
| TS7 `typecheck:fast`, lint, build, diff check | PASS |
| Unauthorized host import mutation | RED in a root `scripts/*.mjs` path; removed, then GREEN |

The initial evaluator verdict was FAIL. It found a public authority mint, an
incorrect outbox path in the evaluation, no controlled receipts in the large
corpus, a recent-delivery feedback bypass, and a root-scripts allowlist gap.
Each counterexample was converted into a regression gate before the final
independent evaluation.

## Actual local baseline

The built workspace CLI reports production-authorized readiness deliveries and
outcomes as `0/0`. The 22 historical deliveries and 21 outcomes remain visible
as `unclassified` technical evidence; exact interaction readiness remains 0.
Read-only validation preserved these canonical values:

- Attunement SHA-256:
  `5292a74aa9379b86f0dd07487dde9b167ef03db84b720a25857fa87ad6c8bfb8`
- tasks SHA-256:
  `7451c229da47f9b12a0b6fa66053707a8b8fe69e5b1f7ada3e2803d6a700b3cc`
- `~/.muse/attunement.interaction-outbox.json`: missing before and after

No fabricated outcome, receipt, permission, or autonomy evidence was written
to the user's store.

## Verdict and limits

PASS for evidence isolation and truthful reporting. Controlled stress data can
exercise the implementation without filling organic readiness.

This is an accidental-laundering and product-integrity boundary, not protection
against malicious code already executing in the Muse process or direct JSON
editing by the local owner. A stronger claim requires a separate process or a
managed signing/MAC boundary. Natural life/work evidence is still 0 and must be
collected through ordinary use over time.
