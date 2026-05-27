# Goal 903 — `muse open` scans the jobs store (catalog completeness)

## Outward change

`muse open <id-prefix>` — the unified "I have an ID, which store owns
it?" lookup — now also scans the background-jobs store. Before, a
`job_<...>` id (printed by `muse job run` / `muse job list`) pasted
into `muse open` returned `(no records found)`, even though the
command's own help says it "scans every store" and `muse job status
<id>` would find it. Now `muse open job_2026-…` resolves to the job's
summary record (status / prompt / start+finish timestamps), so the
generic lookup is honest about covering every ID space.

## Why this, now

A catalog-completeness seam — the exact class the loop has hit before
(export bundle 878, knowledge corpus 866, scheduler-next 890): an
"exhaustive" list that quietly omits one recent store. `muse open`
enumerated seven stores (reminders / followups / objectives /
episodes / patterns-fired / proactive-history / tasks) but not jobs,
which is a first-class ID space the user sees and would naturally try
to inspect. A lookup that claims "every store" and silently misses one
is a correctness gap, not a feature request.

## How

- `commands-jobs` gains an exported `findJobsByIdPrefix(prefix)` that
  returns `{ id, record }[]` for matching job ids, where `record` is
  the existing `jobSummary` (status / prompt / timings). ALL job-file
  knowledge (dir layout, `.jsonl` parsing, status derivation) stays in
  `commands-jobs` — the single source of truth — so `commands-open`
  owns none of it.
- `scanAll` calls it last in the probe order and pushes a
  `kind: "job"` hit; the `Hit.kind` union and the probe-order doc gain
  `job`. Fail-soft (`.catch(() => [])`) like every other store, so a
  jobs-dir read error never breaks the lookup of other stores.

## Verification

`apps/cli` `commands-open.test.ts` (`npx vitest run --root apps/cli
commands-open.test.ts`, 4 passing):
- direct `findJobsByIdPrefix`: seeds two job `.jsonl` files under a
  temp `MUSE_JOBS_DIR`, asserts the prefix returns exactly the match
  with `status: "done"` + the right `prompt`, ignores the non-match;
  returns `[]` when the dir is absent.
- integration through `muse open job_… --json`: asserts
  `kind: "job"` and the summary record's `status`/`prompt`, with the
  other seven stores pointed at absent files so only jobs can match.
Mutation-proven: removing the jobs scan from `scanAll` fails the
integration test; restored green. `pnpm check` fully green (apps/cli
1584, apps/api 323, all packages); `pnpm lint` 0/0. Pure-read, no LLM
path → no smoke:live (Ollama down regardless).

## Decisions

- Put `findJobsByIdPrefix` in `commands-jobs` rather than re-reading
  the jobs dir in `commands-open`: a second copy of the jsonl-parse +
  status-derivation logic would drift from `muse job status` the first
  time either changed.
- Scanned jobs LAST (after tasks): job ids are a distinct `job_`
  namespace that can't collide with the other stores' ids, and the
  existing first-hit/ambiguous logic handles the (impossible-in-
  practice) overlap correctly regardless of order.
