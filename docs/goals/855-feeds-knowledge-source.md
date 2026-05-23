## 855 — feat: watched RSS/Atom feeds become searchable knowledge

## Why

Muse watches RSS/Atom feeds (`muse feeds add/refresh/today`) and the
proactive layer can surface them — but the fetched entries were
**siloed from the agent's reasoning surface**. The knowledge corpus
(notes/tasks/calendar/contacts/email/reminders/followups) did NOT
include feeds, so "any news about the Acme merger?" couldn't be
answered from a feed Muse is actively watching. That's a Knowledge-axis
gap: perception (feeds) that never reaches `knowledge_search` /
`muse recall`. The human direction is explicitly to *expand the thin
Perception/Knowledge axes* and deepen multi-doc RAG with citation.

## Slice — feeds as a knowledge-corpus source

- `@muse/autoconfigure` knowledge-corpus.ts: a `feedsSource`
  (`FeedsKnowledgeSource.recentEntries(limit)` → `FeedEntryLike[]`)
  option; each entry becomes a `feed/<title>` chunk, body prefixed with
  the feed name (`Tech News: <title> (<date>)\n<summary>`). Fail-open
  like every other source. Threaded through
  `NotesKnowledgeSearchToolOptions` so `knowledge_search` spans feeds.
- `feeds-knowledge-source.ts`: `readFeedKnowledgeEntries(file, limit)` —
  reads the CLI's already-fetched JSON store (`~/.muse/feeds.json`,
  written by `muse feeds refresh`), flattens entries across feeds with
  the feed name, newest-first, capped. The XML fetch/parse stays in the
  CLI; the shared layer only reads the persisted JSON. Fail-open ([] on
  missing/malformed) so it never throws into the search path.
- `provider-paths.ts`: `resolveFeedsFile(env)` (`MUSE_FEEDS_FILE` →
  `~/.muse/feeds.json`, mirroring the CLI's own resolution).
- index.ts: wires `feedsSource` into the opt-in `knowledge_search` tool.

## Verify

`@muse/autoconfigure` (250/250):
- knowledge-feeds-source.test.ts — `assembleKnowledgeCorpus` emits a
  `feed/<title>` chunk prefixed with the feed name; a throwing source
  degrades to zero feed chunks; `knowledge_search` (fake embedder)
  answers "any news about the acme merger?" and cites
  `[feed/Acme to merge with Globex]`.
- feeds-knowledge-source.test.ts — `readFeedKnowledgeEntries` flattens
  the real persisted store newest-first, honours the limit, and is
  fail-open on a missing file / malformed JSON / wrong shape.
- **Mutation-proven**: removing the corpus feeds block fails the
  feed-chunk + citation tests; reversing the reader's sort fails the
  newest-first + limit tests.
- `pnpm lint` 0/0; `pnpm check` — autoconfigure 250/250, only the known
  voice-playback `/tmp` flake failed (0 non-voice failures).

## Decisions

- **Read the persisted JSON store, don't relocate the XML parser.** The
  CLI's `muse feeds refresh` already fetches + parses RSS/Atom into a
  stable JSON store; the corpus only needs to read entries. A minimal
  shape-guarded JSON reader in the shared layer avoids both a cross-
  package refactor and any dependency on `fast-xml-parser`.
- **Verified deterministically; live SELECTION [UNVERIFIED-LIVE].**
  Like the reminders (841) / followups (844) sources, the corpus
  assembly + reader are pure and fully tested; the `knowledge_search`
  embedding + tool-selection round-trip needs local Ollama (down this
  session) and rides the standing live-verification mandate.
- No new dependency.
