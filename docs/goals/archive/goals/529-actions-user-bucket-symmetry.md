# 529 — `muse actions --user "   "` falls back to `"local"` instead of leaking other buckets via `queryActionLog`'s empty-string filter bypass (goal-528 sibling on the accountability-log read)

## Why

`apps/cli/src/commands-actions.ts:53` resolved the owner bucket
for the accountability-log read with no fallback:

```ts
const user = options.user.trim();
const all = await queryActionLog(actionLogFile(), user === "all" ? {} : { userId: user });
```

The downstream `queryActionLog` filter
(`packages/mcp/src/personal-action-log-store.ts:109`) uses a
**truthy** check on `userId`:

```ts
const scoped = query.userId ? all.filter((e) => e.userId === query.userId) : all;
```

So when `user.trim() === ""`, the call passes `{ userId: "" }`,
and the truthy check sees `""` as falsy → **no filter** → the
function returns EVERY entry across EVERY user bucket.

Concrete failure mode: a user typing
`muse actions --user "   "` sees the accountability log
**from every other user/bucket** — a privacy bleed where the
operator intended to scope to their own actions but
accidentally exposed someone else's.

Sibling-asymmetry of goal 528, which closed the analogous
asymmetry on `muse objectives list --user "   "` (which
filtered by literal `""` and returned `No objectives.` —
hiding the just-added objective). The mechanism here is
slightly different because `queryActionLog` has a different
filter shape (truthy bypass vs. strict equality), but the user-
visible asymmetry is the same: identical CLI invocations
produce inconsistent observable state.

The default `"local"` (Commander's option default at line 42)
is exactly the right fallback — every user-typed `--user "   "`
should match the default invocation `muse actions` (which sets
`options.user = "local"` and shows only `"local"` entries).

## Slice

- `apps/cli/src/commands-actions.ts` — replaced:
  ```ts
  const user = options.user.trim();
  ```
  with:
  ```ts
  const user = options.user.trim() || "local";
  ```
  Behaviour byte-identical for every non-empty `--user` input
  (including the default `"local"` and the special `"all"`
  case). Only the whitespace-only path is closed.
- `apps/cli/src/commands-actions.test.ts` — added one new
  `it(...)` block that:
  - registers two action-log entries: one under `userId: "local"`,
    one under `userId: "stark"`
  - runs `muse actions --user "   "`
  - asserts stdout contains "local entry" AND does NOT contain
    "stark entry" (pre-fix it contained both — the privacy bleed
    this iteration closes)

## Verify

- New test 1/1 green; full `@muse/cli` suite green (892 passed,
  +2 vs baseline 890, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting back to
  `const user = options.user.trim();` makes the new test fail
  with the precise pre-fix symptom — `expected '2026-05-19T12:
  00:00.000Z  [performed]…' not to contain 'stark entry'`
  (the whitespace `--user` invocation leaks the other bucket's
  entry via the empty-string filter bypass). Every other test
  stays green. Fix restored, suite back to 2 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI filter — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the `muse actions`
  read-surface scope, not the model loop.

## Status

Done. The empty-trim convention now reads identically across
the two paired user-bucket CLI commands:

- `muse objectives {add,list,cancel} --user` (goal 528) —
  fall through to "local" on both sides; just-added objective
  visible to list with the same input
- `muse actions --user` (this goal) — fall through to "local";
  no privacy bleed across buckets via the queryActionLog
  truthy-filter bypass

A future audit can sweep other `options.user.trim()` sites for
the same pattern; this iteration closes the two highest-
sensitivity instances (objectives state + accountability log).

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry CLI
robustness `fix:` on the accountability-log read surface,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Fixed the CLI side rather than the `queryActionLog` filter
  semantics: the truthy check at the store boundary is
  reasonable for an "omit the filter entirely" call shape
  (`query: {}`). The defect is the CLI passing `{ userId: "" }`
  when it meant `{ userId: "local" }`. Changing the store
  would alter the contract for other callers (e.g. `/api/
  actions` future route) — closing the CLI-side asymmetry is
  the narrower fix.
- Did NOT change the `user === "all"` special case: it
  remains the explicit "show every bucket" escape hatch. The
  fallback applies BEFORE the `=== "all"` check, so the
  precedence is: empty → "local" → not "all" → filter by
  "local"; "all" → no filter; any other value → filter by
  that value.
- Step-8 continuation from goal 528 on the analogous CLI
  command — same convention, same package, distinct file
  (accountability log vs. objectives state), distinct
  downstream filter shape (truthy bypass vs. strict equality).
  Productive sibling sweep that completes the user-bucket
  symmetry pair without churning the same code.
- The mutation reverts the single `|| "local"` token rather
  than the whole line shape; the test failure (`expected 'X
  to NOT contain stark entry'`) reproduces the pre-fix
  observable byte-for-byte — leaked entries from another
  bucket.
