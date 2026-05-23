# Goal 911 — `muse runs delete --before` validates the timestamp before the bulk delete

## Outward change

`muse runs delete --before <iso>` now rejects a malformed timestamp
locally with a clear error — `--before must be a valid timestamp (e.g.
2026-05-20 or 2026-05-20T14:00:00Z); got 'yesterday'` — and does NOT
issue the DELETE. A valid value is canonicalised to a full ISO
timestamp before it's sent. Before, the raw `--before` string went
straight into the bulk-delete query unvalidated, so
`muse runs delete --before yesterday` shipped garbage to an
irreversible endpoint: the server's `startedAt <= Invalid Date`
comparison matches nothing, so the user is told the delete "succeeded"
while nothing was pruned — they believe their run history is cleaned
when it isn't.

## Why this, now

Client-side validation in front of an irreversible bulk operation —
the same class as the webhook unparseable-`dueAt` fix (907), but
higher-stakes because this is a DELETE. A silent no-op on a destructive
command is worse than an error: the user moves on believing state
changed. Catching a bad timestamp before the request both prevents the
false-success and gives the user the format to fix it. Runs is mostly a
thin API wrapper, but this is a genuine CLI-side correctness gap, not
wrapper boilerplate.

## How

New pure `normalizeBeforeTimestamp(raw)`: trims, `Date.parse`s, and
returns `new Date(ms).toISOString()` when finite, `undefined`
otherwise. The `delete` action calls it when `--before` is set; on
`undefined` it prints the format error and exits 1 without calling
`apiRequest`; on success the canonical ISO is what goes in the query
(an unambiguous server contract — `2026-05-20` becomes
`2026-05-20T00:00:00.000Z`). The single-run-by-id path and the
"pass one of id/--before" guards are unchanged.

## Verification

`apps/cli` `commands-runs.test.ts` (NEW; `npx vitest run --root
apps/cli commands-runs.test.ts`, 5 passing): `normalizeBeforeTimestamp`
(valid datetime/date → canonical ISO, trim, junk/empty → undefined);
and a command-level harness with a fake `apiRequest` asserting a
malformed `--before` issues NO DELETE + exits 1 + prints the format
error, a valid `--before` sends the canonical ISO in the query, and a
single-id delete still hits `/api/admin/runs/<id>`. Mutation-proven:
removing the validation (passing `options.before` straight through)
fails the no-DELETE and canonical-ISO assertions; restored green.
`pnpm lint` 0/0; apps/cli alone fully green (149 files / 1635 tests) —
the 2 failures under parallel `pnpm check` are the known voice-playback
`/tmp` race flake (pass in isolation). Thin HTTP wrapper + pure
validator, no LLM path → no smoke:live (Ollama down regardless).

## Decisions

- Canonicalised to `toISOString()` rather than forwarding the raw
  (valid) string: the server compares against stored ISO timestamps, so
  a full ISO is the unambiguous contract and `2026-05-20` shouldn't
  depend on the server's date-parsing leniency.
- Validate-and-block rather than warn-and-proceed: this is a DELETE, so
  the safe failure mode is "do nothing and tell the user", not "send it
  anyway and hope the server rejects it".
