# 544 — `resolveLocalTaskId` adds a did-you-mean hint + first direct coverage (goal-543 sibling for `muse task` local-mode)

## Why

`apps/cli/src/commands-tasks.ts:381` defined the local-mode
task-id resolver shared by three commands (`done`, `edit`,
`delete`):

```ts
function resolveLocalTaskId(input: string, all: readonly PersistedTask[]): string {
  const exact = all.find((task) => task.id === input);
  if (exact) return exact.id;
  const matches = all.filter((task) => task.id.startsWith(input));
  if (matches.length === 1) {
    return matches[0]!.id;
  }
  if (matches.length === 0) {
    throw new Error(`task not found: ${input}`);
  }
  throw new Error(`ambiguous task prefix '${input}' matched ${matches.length.toString()} tasks; ...`);
}
```

The "task not found" branch threw a bare message with no
closest-match hint. Task ids are UUID-shaped (40+ chars), so
one-character typos and short-prefix-misses are the dominant
error mode — exactly what `closestCommandName` was designed
for.

Same CLI did-you-mean defect class as goals 153 / 468 / 535 /
543. The convention already covers `muse feeds remove`,
`muse approve <id>`, `muse config set <key>`, and
`muse objectives cancel <id>` (just landed in 543). Local-mode
`muse task {done,edit,delete}` was the remaining outlier.

Also: `resolveLocalTaskId` had **zero direct test coverage** —
the existing `commands-tasks.test.ts` only exercised the
remote-mode `add` path with a mocked apiRequest, leaving the
local-mode helpers untested.

## Slice

- `apps/cli/src/commands-tasks.ts` — promoted
  `resolveLocalTaskId` to `export function` (small widening
  for testability) and added the did-you-mean branch:
  ```ts
  if (matches.length === 0) {
    const suggestion = closestCommandName(input.trim(), all.map((t) => t.id));
    const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
    throw new Error(`task not found: ${input}${hint}`);
  }
  ```
  Behaviour byte-identical for every clean exact-id /
  unambiguous-prefix / ambiguous-prefix path — only the
  "no matches" branch now appends the typo hint when there's
  a close match.
- `apps/cli/src/commands-tasks.test.ts` — added one new
  `describe(...)` block with 5 focused tests:
  - exact-id resolves verbatim (regression pin)
  - unambiguous prefix resolves (regression pin)
  - ambiguous prefix throws with count + guidance
    (regression pin)
  - near-miss typo (one-char swap on trailing char) → hint
    fires (THE defect this iteration closes)
  - unrelated input → NO hint (avoids random noise)

## Verify

- New tests 5/5 green; full `@muse/cli` suite green (940
  passed, +6 vs baseline 934, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  not-found branch back to a bare
  `throw new Error(\`task not found: ${input}\`)` makes the
  typo-hint test fail with the precise pre-fix symptom —
  `expected [Function] to throw error matching /task not
  found: task_abc123dex — did…/u but got 'task not found:
  task_abc123dex'`. Fix restored, suite back to 5 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI error-message helper — no LLM request-response
  wire path; `smoke:live` does not apply (per `testing.md`
  / iteration-loop Step 9). The defended paths are
  `muse task {done,edit,delete} --local <id>` error
  surfaces, not the model loop.

## Status

Done. A typo'd `muse task done task_abc123dex` now produces:

```
Task task_abc123dex not found: task_abc123dex — did you mean 'task_abc123def'?
```

…instead of the opaque `Task task_abc123dex not found`. The
CLI did-you-mean convention now covers every command-id
surface in the codebase:

- `muse feeds {remove,refresh} --id` (153)
- `muse jobs list --status` (151)
- `muse approve <id>` / `muse deny <id>` (472-476)
- `muse config set <key>` (535)
- `muse objectives cancel <id>` (543)
- `muse task {done,edit,delete} <id>` (this goal, via the
  shared `resolveLocalTaskId`)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a CLI-ergonomics polish +
first-coverage `fix:` on `resolveLocalTaskId`, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Step-8 continuation from goal 543 onto the analogous task-
  id resolver. Same convention, distinct shared helper, three
  command surfaces (`done`/`edit`/`delete`) benefit from one
  fix.
- Modified the shared `resolveLocalTaskId` rather than each
  caller: the helper is the canonical id-resolution boundary;
  improving it once propagates to all three commands without
  duplicating the closestCommandName call site three times.
- Did NOT touch `commands-remind.ts`'s analogous
  `resolveLocalReminderId` (line 562). Confirmed it has the
  same shape but I haven't checked whether reminders ids are
  UUID-shaped (they are — generated via `randomUUID()` too).
  Mirroring this fix there is a clean follow-up iteration;
  scope discipline keeps this one tight.
- Promoted `resolveLocalTaskId` to `export` for direct
  testing. Pre-fix the helper was effectively untested
  (only exercised via the three local-mode command paths
  end-to-end). The same widening was applied to
  `approvalsPath`/`trustPath` in goal 539 for the same
  reason.
- The 5 tests pin the full input contract: exact-id, prefix-
  unambiguous, prefix-ambiguous, near-miss-typo (with hint),
  and unrelated-input (no hint). The "no hint" branch is as
  important as the "with hint" branch — a random-feeling
  suggestion would be worse than no suggestion at all.
- The mutation reverts only the 4-line hint block to the
  pre-fix one-liner; the test failure (`expected [Function]
  to throw error matching /did you mean/u`) reproduces the
  pre-fix observable byte-for-byte.
