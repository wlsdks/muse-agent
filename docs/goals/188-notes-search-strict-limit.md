# 188 — `muse notes search --limit` strict + consistent

## Why

`muse notes search` handled `--limit` two different ways:

- **local** path: `Number(options.limit)`; if not finite the
  limit was *silently dropped* (tool default used, no signal);
  `0` / negative were *passed through* to the tool (undefined
  behaviour).
- **remote** path: the raw string forwarded to the server, no
  client-side validation.

So `--limit 20x` silently behaved as "no limit" locally, and
the two surfaces disagreed. Same silent-numeric anti-pattern
fixed across the CLI (143/144/155/177/178/179/184), still
present on this notes surface plus a local/remote
inconsistency.

## Scope

- `apps/cli/src/commands-notes.ts`:
  - New exported `parseNotesSearchLimit(raw)`: absent/blank →
    `undefined` (let the server/tool use its own default); a
    genuine positive number is truncated; non-numeric /
    non-positive throws `--limit must be a positive number
    (got '<raw>')`.
  - Parsed once up front; both the local (`args.limit`) and
    remote (`params.set("limit", …)`) branches use the single
    validated value — now consistent.
- `apps/cli/src/commands-notes.test.ts` (new): 4 cases —
  absent→undefined, valid+trunc, unit-slip/non-numeric throw,
  0/negative throw.

## Verify

- `pnpm --filter @muse/cli test` — 490 pass (4 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (pure numeric parsing + a request
  param; smoke:live not required).

## Status

done — `muse notes search --limit` joins the strict-numeric
line and its local/remote paths now validate identically; a
fat-fingered `--limit` is a clear rejection on both, not a
silent no-limit (local) / server-dependent (remote) split.
