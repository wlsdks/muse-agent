# Goal 928 — `muse today` surfaces recent feed headlines in the morning brief

## Outward change (NEW capability)

The daily brief (`muse today`) now includes a **Headlines** section —
the most recent items published across the user's subscribed feeds
within the lookahead window (default 24h), newest-first, capped at 5.
Before, the brief composed tasks / events / notes / reminders /
followups / weather but never touched feeds, so the "ambient
world-state" Muse ingests (`muse feeds`) was absent from the one
command a user actually reads each morning. Now the morning brief
answers "and what happened in my world?" alongside "what's on my
plate."

```
Today (Sat May 24, next 24h)
...
Headlines (3):
  - [tech] Rust 2.0 released
  - [news] Local election results
  - [hn] Show HN: a tiny thing
```

## Why this, now

Feeds are explicitly Muse's ambient-perception stream, and weather —
the other purely-informational, client-resolved brief element — is
already merged into the brief. Feed headlines are the natural sibling:
informational context the user wants surfaced proactively in their
daily glance, not only on an explicit `muse feeds today`. This is the
P20 Perception EXPAND mandate — deepening the brief so the thin
"what's going on" axis is part of the daily driver, not a separate
command.

## How

Mirrors the **weather** pattern exactly: `resolveTodayFeedHeadlines`
reads the local feeds store CLIENT-side, filters each feed to the
lookahead window (reusing `filterRecentFeedEntries`), flattens + sorts
newest-first (`compareFeedEntriesNewestFirst`), caps to
`DEFAULT_TODAY_HEADLINES_CAP` (5); the result is merged onto the
briefing AFTER the local/remote fetch — exactly where the weather line
is merged (lines 161-173). So headlines appear on BOTH paths (the API
daemon doesn't compose feeds; the client supplies them), with no
local/remote inconsistency. Fail-soft: a missing / unreadable feeds
store yields `undefined` and the section is simply omitted.
`formatHeadlines` renders the section, stripping ESC/C0/C1/DEL from
the third-party feed titles (same terminal-injection guard as
events/inbox/feeds). The empty-state onboarding hint now also counts
headlines as content.

## Verification

`apps/cli` `commands-today.test.ts` (`npx vitest run --root apps/cli
commands-today.test.ts`, 19 passing — 5 new):
- `resolveTodayFeedHeadlines` over a seeded on-disk feeds store:
  returns only entries within the 24h window (a 48h-old item is
  excluded), newest-first across feeds; respects the cap; fail-soft →
  `undefined` on a missing store;
- `formatHeadlines`: renders the section, strips terminal-control
  bytes from a hostile feed title, returns "" for undefined/empty.

Mutation-proven: forcing the window cutoff into the future (so nothing
is "recent") fails the window + cap tests; restored green. `pnpm
check` green across every workspace bar the unrelated known
voice-playback `/tmp` mkdtemp flake (apps/cli today 19/19 in
isolation; build/tsc green all packages). `pnpm lint` 0/0.

The default + `--json` structured brief is fully deterministic and
offline-verified. The `--brief` prose path serializes the whole
briefing to the model (`JSON.stringify`), so headlines now ride into
that prompt too — a low-risk additive change, but model-facing, and
`smoke:live` is blocked (Ollama down). That prose aspect is therefore
tagged `[UNVERIFIED-LIVE]`; it clears in the same pass as the other
`[UNVERIFIED-LIVE]` tags the moment Ollama is reachable.

## Decisions

- Merged client-side post-fetch (like weather), NOT inside
  `composeLocalBriefing` — that gives both the local and remote/daemon
  paths the headlines from one code path with no inconsistency, since
  the feeds store is always local to the CLI host.
- Capped at 5 and lookahead-windowed — the brief must stay a glance,
  not a full feed dump (`muse feeds today` / `muse feeds search` remain
  the full views).
- Reused `filterRecentFeedEntries` + `compareFeedEntriesNewestFirst` +
  the shared terminal strip, so windowing / ordering / safety match the
  rest of the feeds surface exactly.
