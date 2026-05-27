# 545 — `resolveLocalReminderId` adds a did-you-mean hint + first direct coverage (goal-544 sibling for `muse remind` local-mode)

## Why

Goal 544's "Remaining risks" explicitly flagged
`apps/cli/src/commands-remind.ts:554` `resolveLocalReminderId`
as the analogous helper with the same defect shape.
Pre-iteration:

```ts
function resolveLocalReminderId(input: string, all: readonly PersistedReminder[]): string {
  const exact = all.find((reminder) => reminder.id === input);
  if (exact) return exact.id;
  const matches = all.filter((reminder) => reminder.id.startsWith(input));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) {
    throw new Error(`reminder not found: ${input}`);
  }
  throw new Error(`ambiguous reminder prefix ...`);
}
```

The "not found" branch threw an opaque error with no
closest-match hint. Reminder ids are UUID-shaped (40+ chars
via `randomUUID()`), so one-character typos are the dominant
error mode — exactly what `closestCommandName` handles.

Same CLI did-you-mean defect class as goals 153 / 468 / 535 /
543 / 544. The convention covered every command-id surface in
the codebase EXCEPT this one (the only remaining outlier
flagged in goal 544).

`resolveLocalReminderId` had **zero direct test coverage**.

## Slice

- `apps/cli/src/commands-remind.ts` — promoted
  `resolveLocalReminderId` to `export function` and added
  the did-you-mean branch:
  ```ts
  if (matches.length === 0) {
    const suggestion = closestCommandName(input.trim(), all.map((r) => r.id));
    const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
    throw new Error(`reminder not found: ${input}${hint}`);
  }
  ```
  Same shape as goal 544's `resolveLocalTaskId` fix byte-for-
  byte. Behaviour byte-identical for every clean exact-id /
  unambiguous-prefix / ambiguous-prefix path.
- `apps/cli/src/commands-remind.test.ts` — added one new
  `describe(...)` block with 5 focused tests mirroring goal
  544's `resolveLocalTaskId` matrix:
  - exact-id resolves verbatim
  - unambiguous prefix resolves
  - ambiguous prefix throws with count + guidance
  - near-miss typo (one-char swap) → hint fires
  - unrelated input → NO hint (avoids random noise)

## Verify

- New tests 5/5 green; full `@muse/cli` suite green (950
  passed, +10 vs baseline 940 — 5 new + 5 from goal 544 not
  yet rolled into the baseline I quoted, 0 failed); tsc
  strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  not-found branch back to the bare
  `throw new Error(\`reminder not found: ${input}\`)` makes
  the typo-hint test fail with the precise pre-fix symptom —
  `expected [Function] to throw error matching /reminder not
  found: rem_abc123dex — …/u but got 'reminder not found:
  rem_abc123dex'`. Fix restored, suite back to 5 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI error-message helper — no LLM request-response
  wire path; `smoke:live` does not apply (per `testing.md`
  / iteration-loop Step 9). The defended paths are
  `muse remind {fire,snooze,cancel} --local <id>` error
  surfaces, not the model loop.

## Status

Done. `muse remind snooze rem_abc123dex` now produces:

```
reminder not found: rem_abc123dex — did you mean 'rem_abc123def'?
```

…instead of the opaque `reminder not found: rem_abc123dex`.
The CLI did-you-mean convention now reads identically across
**every** command-id surface in the codebase — no remaining
outliers:

- `muse feeds {remove,refresh} --id` (153)
- `muse jobs list --status` (151)
- `muse approve <id>` / `muse deny <id>` (472-476)
- `muse config set <key>` (535)
- `muse objectives cancel <id>` (543)
- `muse task {done,edit,delete} <id>` local-mode (544)
- `muse remind {fire,snooze,cancel} <id>` local-mode (this goal)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a CLI-ergonomics polish +
first-coverage `fix:` on `resolveLocalReminderId`, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Step-8 continuation from goal 544 onto the analogous
  reminder-id resolver — completing the goal-544 "Remaining
  risks" note and closing the entire CLI did-you-mean
  convention sweep.
- Used the same shape as `resolveLocalTaskId` byte-for-byte
  (3-line hint block, `input.trim()` argument, `all.map(r =>
  r.id)` candidates). Cross-package convention reads
  identically — a future maintainer scanning either helper
  sees the same pattern.
- Promoted `resolveLocalReminderId` to `export` for direct
  testing. Pre-fix the helper was effectively untested
  (only exercised via the three local-mode command paths
  end-to-end). Same widening pattern as goal 544.
- The 5-test matrix mirrors goal 544's test layout exactly:
  exact-id / unambiguous-prefix / ambiguous-prefix / near-
  miss-typo (with hint) / unrelated-input (no hint). The
  parallel test structure makes the cross-CLI convention
  visible at the test level too.
- The mutation reverts only the 4-line hint block to the
  pre-fix one-liner; the test failure (`expected [Function]
  to throw error matching /did you mean/u`) reproduces the
  pre-fix observable byte-for-byte.
