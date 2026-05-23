# Goal 925 — `muse feeds refresh` reports the count actually re-fetched, not attempted

## Outward change

`muse feeds refresh` now tells the truth about how many feeds it
actually pulled. `refreshSingleFeed` is fail-soft — a feed that 404s,
times out, or exceeds the body cap prints a per-feed error to stderr
and keeps its old cached entries — but the summary line always printed
`Refreshed N feed(s)` where `N` was the count *attempted*. So a user
whose feeds were all down saw `Refreshed 3 feed(s)`, assumed success,
then found `muse feeds today` empty with no idea why.

Now:
- all succeeded → `Refreshed 3 feed(s)` (unchanged);
- some failed → `Refreshed 1 of 3 feed(s) (2 failed — see errors
  above)`;
- all failed → `Refreshed 0 of 3 feed(s) (3 failed — …)` **and exit
  code 1**, so a cron / script wrapping `muse feeds refresh` notices a
  total outage instead of treating it as success.

A partial failure stays exit 0 — the fail-soft contract (one dead feed
shouldn't fail the whole run) is preserved; only the message becomes
honest.

## Why this, now

Feeds is the ambient-perception surface a daily driver leans on ("what
happened in my world today"). A refresh that silently reports success
while fetching nothing is the worst kind of perception bug: the user
trusts a stale/empty picture. The command already did the hard part
(retry-with-backoff, body cap, per-feed fail-soft); the only thing
missing was an honest tally. This is the "validate / surface, don't
silently succeed" class applied to a perception actuator's own status
report.

## How

`refreshSingleFeed` now returns `{ record, ok }` (`ok` is false only on
the catch path — a thrown fetch / non-ok / timeout / body-cap; a
successful fetch that parsed zero new entries is still a success). The
refresh loop counts `succeeded` among the targets and the summary
branches on `succeeded === targets.length`. A total failure
(`succeeded === 0`) sets `process.exitCode = 1`.

## Verification

`apps/cli` `commands-feeds.test.ts` (`npx vitest run --root apps/cli
commands-feeds.test.ts`, 31 passing) over deterministic `file://`
fixtures (a real RSS fixture for success, a non-existent path so
`loadFeedBody`'s `readFile` rejects for failure):
- a fully-failed refresh → `Refreshed 0 of 1 feed(s) (1 failed`, the
  per-feed stderr line, and exit 1 (NOT `Refreshed 1 feed(s)`);
- a partial failure → `Refreshed 1 of 2 feed(s) (1 failed`, exit 0;
- an all-success refresh → plain `Refreshed 2 feed(s)`, no `of 2`.

Mutation-proven: reverting the summary to the unconditional `Refreshed
${targets.length} feed(s)` fails the two failure-count tests (the
all-success test still passes); restored green.

Also converted the pre-existing `refresh --id whitespace` test from a
`https://example.com/...` seed (a real network call that could hang
past vitest's 5s timeout — the documented feeds flake) to the same
deterministic `file://` fixture, removing that flake while keeping its
trimmed-`--id`-routing assertion.

`pnpm check` green across every workspace bar the unrelated known
voice-playback `/tmp` mkdtemp flake (apps/cli passes feeds 31/31 in
isolation; build/tsc green for all packages). `pnpm lint` 0/0.
Deterministic CLI summary logic, no LLM path → no smoke:live (Ollama
down regardless).

## Decisions

- `ok` reflects "did the fetch complete", not "were there new
  entries". A live feed with nothing new this hour is a success — the
  count must not punish a quiet feed, only a broken one.
- Total failure exits 1, partial stays 0. A script that refreshes
  before reading wants to know when EVERYTHING is down (actionable),
  but a single flaky feed among many is the fail-soft case the command
  was built for — failing the whole invocation there would defeat the
  point.
- Fixed the flaky whitespace test in the same slice — it exercises the
  same `refresh` path the fix touches, and its network dependency was
  both the flake source and a tacit encoding of the old (count-ignores-
  failure) behaviour.
