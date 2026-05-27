# 528 — `muse objectives list` resolves `--user "   "` to the same `"local"` fallback that `muse objectives add` uses (sibling-asymmetry on the objectives CLI bucket boundary)

## Why

`apps/cli/src/commands-objectives.ts:64` resolved the owner
bucket for `add`:

```ts
userId: options.user.trim() || "local"
```

…but the analogous filter in `list` (line 82) did NOT use the
same fallback:

```ts
const all = (await readObjectives(objectivesFile())).filter((o) => o.userId === options.user.trim());
```

Concrete asymmetry. A user typing
`muse objectives add foo --user "   "`:

1. add: `options.user.trim() = ""` → `"" || "local"` → registers
   the objective with `userId: "local"` ✓
2. list with the same input: `muse objectives list --user "   "`:
   `o.userId === ""` filter → matches nothing → prints
   `"No objectives."` 

Two CLI invocations with identical `--user` value produce
**inconsistent observable state**: the objective is registered
but invisible to the operator. Worse, the operator may then
re-add (creating a duplicate `"local"` entry) thinking the
first add silently failed.

Sibling-asymmetry of the goal-520 / 521 empty-trim defect class
applied to the **bucket-resolution** boundary (a different
semantic from the slug-fallback boundary). The
`"" || "local"` fallback was already established in `add` —
this iteration closes the asymmetry on the read side.

## Slice

- `apps/cli/src/commands-objectives.ts` — replace the filter:
  ```ts
  const ownerBucket = options.user.trim() || "local";
  const all = (await readObjectives(objectivesFile())).filter((o) => o.userId === ownerBucket);
  ```
  Behaviour byte-identical for every non-empty `--user` input
  (including the default `"local"` from Commander's option
  default at line 77, since `"local".trim() || "local"` is
  `"local"`). Only the whitespace-only path is closed.
- `apps/cli/src/commands-objectives.test.ts` — added one new
  `it(...)` block that:
  - `muse objectives add "trim test" --user "   "` (succeeds,
    creates an objective under `"local"`)
  - `muse objectives list --user "   "` (must now show
    "trim test" — pre-fix this returned `"No objectives.\n"`)
  - sanity: `muse objectives list --user local` also shows it
    (proves both invocations now resolve to the same bucket)

## Verify

- New test 1/1 green; full `@muse/cli` suite green (890
  passed, +1 vs baseline 889, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the filter
  to `o.userId === options.user.trim()` makes the new test
  fail with the precise pre-fix symptom — `list with the same
  whitespace --user must show the just-added objective; pre-
  fix it filtered by literal '' and returned 'No
  objectives.': expected 'No objectives.\n' to contain 'trim
  test'`. Every other test stays green. Fix restored, suite
  back to 1 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI filter — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the `muse objectives
  list` consumer-state, not the model loop.

## Status

Done. A whitespace-only `--user` argument now resolves to the
same `"local"` bucket on both `add` and `list`; the just-
registered objective is visible to the list. The cross-CLI
empty-trim convention now reads identically across:

- `muse feeds add --id` (goal 520) — fall through to slug
- `muse feeds add <url>` (goal 521) — reject loudly
- `muse objectives {add,list} --user` (this goal) — fall
  through to "local" on both sides

Different fallback shapes for different semantics — but the
convention "decide once, apply identically across paired
commands" is now consistent.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry CLI-state
robustness `fix:` on the objectives bucket boundary,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the finite-Date / NaN-guard run (522–527)
  to the empty-trim sibling-asymmetry class on a different
  surface. Productive variation, not same-area churn.
- Used the same `options.user.trim() || "local"` shape as
  `add` rather than extracting a helper: the expression is
  one line, used twice in the same file. A helper would
  invite over-abstraction for a 3-character literal that's
  already documented by Commander's option default ("owner
  bucket", "local"). If a third call site appears, that's
  the right time to extract.
- Did NOT touch `cancel` — it takes only `<id>` as a
  positional arg, no `--user`. The `o.userId` filter is
  enforced elsewhere (by the unique objective id at
  `patchObjective`'s file lookup). Different code path,
  different concern.
- The mutation reverts the filter to its pre-fix line
  exactly; the test failure (`expected 'No objectives.\n'
  to contain 'trim test'`) reproduces the pre-fix
  observable byte-for-byte.
- Test names use `--user "   "` (3 spaces) consistently
  across both add and list to make the asymmetry visible at
  the call site.
