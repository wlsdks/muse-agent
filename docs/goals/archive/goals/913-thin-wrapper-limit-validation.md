# Goal 913 — `runs list` / `debug replay` validate `--limit` instead of forwarding it raw

## Outward change

`muse runs list --limit` and `muse debug replay --limit` now validate
the value client-side: a non-numeric `--limit abc` fails with
`--limit must be an integer in [1, 1000] (got 'abc')` and issues NO
request, and an over-max value is clamped to the documented `1000`.
Before, both shipped the raw string straight into the query
(`?limit=${encodeURIComponent(options.limit)}`), so `--limit abc` sent
garbage to the API and `--limit 999999` ignored the `max 1000` the
help text promises — the CLI advertised a bound it didn't enforce.

## Why this, now

A consistency + documented-contract gap across the thin-wrapper list
commands. Their sibling `orchestrate list` already validates `--limit`
via `parseBoundedInt`; `runs list` and `debug replay` were the two
that forwarded raw. Enforcing the bound the help already states (and
rejecting non-numeric input with a clear message) is the same
input-validation class as the webhook `dueAt` (907) and `runs delete
--before` (911) fixes — lower-stakes (a GET), but it brings the three
list commands to one consistent contract and stops the CLI from
lying about `max 1000`.

## How

Both actions now call
`parseBoundedInt(options.limit, "--limit", 1, 1000, <default>)` when
`--limit` is set (`runs` default 20, `debug` default 50 — matching
each help string), build the query from the validated integer, and
omit the query param entirely when `--limit` is unset.
`parseBoundedInt` (shared with `orchestrate`/`ask`) throws on
non-finite / below-min and clamps to max — so the throw surfaces as a
clear CLI error and an over-max clamps down. `debug replay`'s help
gained the `max 1000` note it now enforces.

## Verification

`apps/cli` `commands-runs.test.ts` + NEW `commands-debug.test.ts`
(`npx vitest run --root apps/cli commands-runs.test.ts
commands-debug.test.ts`, 11 passing): each command's `--limit` via a
fake `apiRequest` harness — non-numeric → throws + NO request;
over-max → query clamped to `limit=1000`; valid → `limit=<n>`; unset →
no query param. Mutation-proven: reverting `runs list` to the raw
forward fails the reject-non-numeric and clamp assertions; restored
green. `pnpm check` green (apps/cli 1647, apps/api 323); `pnpm lint`
0/0. Thin HTTP wrappers + shared validator, no LLM path → no
smoke:live (Ollama down regardless).

## Decisions

- Reused `parseBoundedInt` rather than a bespoke check — it's the
  validator `orchestrate list` and `ask` already use, so the three
  list surfaces share one parse/clamp/error contract.
- Capped `debug replay` at 1000 (its help previously stated only a
  default, no max): a generous upper bound that still rejects garbage
  and an absurd page size, matching the `runs` cap rather than
  inventing a new number.
