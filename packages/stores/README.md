# @muse/stores

The file-backed personal stores: one module per store (contacts, tasks, reminders, episodes,
playbook, followups, veto, consent, action log, works, and more), each reading/writing a
single JSON file under the user's Muse config directory. It is a package rather than a folder
because every one of these stores shares the same atomic-write, encryption-at-rest, and
mutation-queue primitives, and callers must not reach past that shared contract to raw `fs`.

## Public surface

- `atomicWriteFile`, `withFileMutationQueue` (also at `./atomic-file-store`) — the atomic
  write + serialized-mutation primitives every store above builds on.
- `personal-contacts-store.js`, `personal-tasks-store.js`, `personal-reminders-store.js`,
  `personal-episodes-store.js`, `personal-playbook-store.js`, `personal-veto-store.js`,
  `personal-consent-store.js`, `personal-objectives-store.js`, `personal-followups-store.js`,
  `works-store.js` — the personal-data stores, each with read/write/query/serialize exports.
- `encryptFileAtRest`, `decryptFileAtRest`, `encrypted-credentials.js` — encryption-at-rest
  and OS-credential-store helpers used by the stores above that hold sensitive data.
- `appendActionLog`, `verifyActionLogChainFile` — the append-only, chain-verified action log.
- `FileProgressiveAutonomyAdminStore` (`./host-progressive-autonomy`) and
  `FileProgressiveAutonomyOpportunityStore` (`./host-progressive-autonomy-opportunities`) —
  the progressive-autonomy admin and opportunity-review stores.
- `withDigestLock`, `withProcessLock`, `FileLocalModelExecutionLeaseCoordinator` — cross-process
  locking and local-model execution leasing.
- `readWeaknesses`, `recordWeakness` (`weakness-ledger.js`) — the Whetstone weakness ledger.

## Depends on

- `@muse/memory` — shared memory-store types (e.g. user-model slot shapes) some stores persist.
- `@muse/policy` — capability/consent types referenced by the consent and veto stores.
- `@muse/mcp-shared` — retry helpers used by store operations that touch external services.
- `@muse/shared` — shared types and utilities.

## Rules that bind this package

- [`../../.claude/rules/outbound-safety.md`](../../.claude/rules/outbound-safety.md) — `personal-consent-store.js` is the persistence
  layer for the "standing objectives need recorded scoped consent" rule (`performConsentedAction`);
  `personal-veto-store.js` backs the record/veto side of every autonomous action.
- [`../../.claude/rules/architecture.md`](../../.claude/rules/architecture.md) — PostgreSQL is the source of truth for *server* state;
  this package is deliberately the local file-backed counterpart for the CLI/daily-driver path.

## Tests

```bash
pnpm --filter @muse/stores test
```
