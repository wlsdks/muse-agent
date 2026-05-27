# Goal 927 — `muse feeds search <query>` searches the cached feed archive

## Outward change (NEW capability)

`muse feeds search <query>` is a new subcommand that searches the
WHOLE locally-cached feed archive by keyword — case-insensitive
substring over each entry's title + summary, across every feed,
newest-first. Before, the only way to look at ingested feed content
was `muse feeds today [--hours N]`, which reaches only a recent
time-window; the rest of the archive (up to `DEFAULT_FEED_ENTRIES_CAP`
= 200 entries per feed, merged across refreshes) was unreachable. So
"find that article about Rust I saw last week" had no answer — the
data was on disk but unqueryable.

```
muse feeds search rust
muse feeds search "gpu prices" --limit 5
muse feeds search rust --json
```

The falsifiable outward test: name the new thing Muse can do in the
user's world — search their accumulated feed archive by keyword — and
the command to exercise it: `muse feeds search <query>`.

## Why this, now

Feeds is the ambient-perception surface Muse already ingests into (P20
Perception). A feed reader without archive search is incomplete — it's
a standard, expected capability, and the absence meant the 200-per-feed
archive Muse carefully retains (goal 115 merge/dedup) served only the
narrow "today" view. This is EXPAND, not another guard: a genuinely new
user-facing verb that makes already-captured data useful. Zero-cost,
local-only, deterministic — no new dependency, no network at query
time (reads the on-disk store).

## How

- `searchFeedEntries(feeds, query, limit)` — pure: lowercases the
  query, substring-matches title OR summary across all feeds, maps to
  `FeedSearchHit` (carries feedId + feedName for the listing), sorts
  newest-first via the existing `compareFeedEntriesNewestFirst`
  (shared with `today`/refresh, so ordering can't drift), slices to
  `limit`. Empty query → `[]`.
- `parseFeedSearchLimit(raw, fallback, cap)` — strict `--limit`:
  default 20, cap 100; a unit-slip (`20x`) / non-positive rejects
  rather than silently defaulting (the established CLI numeric-flag
  contract).
- The `search` subcommand reads the store, runs the pure search,
  renders via the existing `formatFeedEntryLines` (which already strips
  terminal-control bytes from third-party feed text — so archive search
  output is terminal-safe by reuse) or `--json`. An empty result prints
  a clear hint; a missing query exits 1.

## Verification

`apps/cli` `commands-feeds.test.ts` (`npx vitest run --root apps/cli
commands-feeds.test.ts`, 40 passing — 9 new):
- `searchFeedEntries`: matches title OR summary case-insensitively
  across feeds (a "rust" query hits a title "Rust 2.0" AND a summary
  "RUST belt"), newest-first ordering, limit clamp, empty query → `[]`,
  and the hit carries feedId/feedName;
- `parseFeedSearchLimit`: default / clamp-to-cap / reject `20x` / reject
  `0`;
- end-to-end via the real `registerFeedsCommand` over a seeded
  on-disk archive: lists matching entries newest-first, the clear
  empty-state on no match, `--json` structured payload, query-required
  exit 1, and a bad `--limit` rejected.

Mutation-proven: neutralising the `searchFeedEntries` filter (match
nothing) fails the match/ordering/e2e tests (5 failures); restored
green. `pnpm check` green across every workspace bar the unrelated
known voice-playback `/tmp` mkdtemp flake (apps/cli feeds 40/40 in
isolation; build/tsc green all packages). `pnpm lint` 0/0. Deterministic
local capability, no LLM/request-response path → no smoke:live (Ollama
down regardless).

## Decisions

- Substring (not embedding/semantic) search — feeds are a high-volume
  ambient stream where exact-keyword recall ("the post that mentioned
  X") is the common need, it's instant and offline, and `muse recall`
  already covers semantic search over notes+episodes. Keeping feeds
  search lexical avoids a redundant embedding pipeline + the Ollama
  dependency.
- Reused `compareFeedEntriesNewestFirst` + `formatFeedEntryLines`
  rather than new ordering/format code, so search output matches
  `today` exactly and inherits its terminal-injection strip.
- Query joined from variadic args (`<query...>`) so `muse feeds search
  gpu prices` works without quoting, matching `muse episode search`.
