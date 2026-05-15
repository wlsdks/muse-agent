# 115 — `muse feeds refresh` merges incoming entries instead of overwriting

## Why

`refreshSingleFeed` set `feed.entries = parseFeedBody(body)` —
the latest fetch wholesale replaced the on-disk list. RSS / Atom
servers typically expose only the most recent 20-50 items, so
any entry that rolled off the publisher's window vanished
locally on the next `muse feeds refresh`.

For an ambient-awareness store this is wrong: the local archive
should be the **historical** record. JARVIS doesn't forget what
the world said yesterday just because the publisher's feed only
shows today.

## Scope

- `apps/cli/src/feeds-store.ts`:
  - New pure helper `mergeFeedEntries(previous, incoming, cap?)`:
    - Dedup by `entry.id` (incoming wins on republish — covers
      the common pattern of edited titles / corrected summaries).
    - Sort newest-first by `publishedAt`; missing / unparseable
      dates sort to the tail in input order.
    - Slice to `cap` (default `DEFAULT_FEED_ENTRIES_CAP = 200` ≈
      200 KB per feed). Invalid caps (0 / negative / NaN) fall
      back to the default.
  - `DEFAULT_FEED_ENTRIES_CAP` exported for downstream tuning.
- `apps/cli/src/commands-feeds.ts` `refreshSingleFeed`:
  - Routes the incoming entries through `mergeFeedEntries` with
    the existing `record.entries` as the previous archive.

## Verify

- New `apps/cli/test/program.test.ts` case pins every branch:
  - 3-way merge: `a` stays (rolled-off but archived), `b`
    updates (republished with new title), `c` is new.
  - Sort order is newest-first; missing-date entries go to tail.
  - Cap clips; invalid caps (0 / -1 / NaN) fall back to default.
  - Empty inputs are safe (`[], []` → `[]`).
- `pnpm --filter @muse/cli test` — 337 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (helper is pure).

## Status

done — local feed archives now accumulate history correctly.
A `feeds.json` that's seen 1000+ entries per feed across many
refresh cycles stays bounded at 200/feed without losing the
most-recent window.
