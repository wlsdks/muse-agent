## 856 — fix: `knowledge_search` description matches the breadth it spans (and stops steering away from feeds)

## Why

855 put the user's watched RSS/Atom feeds into the knowledge corpus,
but the `knowledge_search` tool the local model sees still described
itself as "the user's personal notes (and ingested documents)" and
ended with **"do not use for ... live web data."** On a cheap local
Qwen (reasoning=false), the description is the entire selection signal
— so for "any news about the merger?" the model reads "notes only, not
web data" and does NOT pick `knowledge_search`, even though the answer
is now sitting in a feed Muse fetched. The just-shipped capability (and
the 7 other corpus sources — tasks/calendar/contacts/email/reminders/
followups) were effectively unreachable through the model. This is the
standing #1 priority: a tool that exists but the local model won't
select in one shot is not delivered.

## Slice — description + arg-example that surface the real span

`@muse/autoconfigure` knowledge-corpus.ts (the `knowledge_search`
definition; it's always-on — no domain — so the description is the only
selection lever):
- Description now names what the corpus actually spans: notes, ingested
  documents, tasks, calendar, contacts, recent emails, reminders,
  follow-ups, and **the news/RSS feeds they watch** — and says to use it
  for "any news about X from their feeds."
- The misleading "do not use for ... live web data" steer is replaced
  with the precise boundary that still holds: do not use to **open a NEW
  web page**, or for general world facts the user never saved.
- The query arg example gains a feeds + an email example
  ('any news about the merger', 'what did Sam email me about the
  launch') so the model fills the arg for those intents too.

## Verify

`@muse/autoconfigure` knowledge-search-wiring.test.ts (+1):
- the description contains "feeds" and "news", no longer contains
  "live web data", and still contains the "web page" boundary.
- **Mutation-proven**: restoring the old notes-only / "live web data"
  description fails the new contract test.
- `pnpm check` EXIT 0, `pnpm lint` 0/0, autoconfigure suite green.

## Decisions

- **Contract pinned deterministically; live SELECTION
  [UNVERIFIED-LIVE].** The description is sent to the model, so the
  selection improvement needs a local-Qwen `smoke:live` round-trip
  ("any news about X?" → `knowledge_search`) — Ollama is down this
  session, so it rides the standing live mandate (same posture as 849).
  The string contract (breadth named, misleading steer removed) is the
  deterministic, mutation-killed check.
- **Keep the web-fetch boundary.** Dropping "live web data" risks the
  model reaching for `knowledge_search` to fetch a URL; the replacement
  ("do not use to open a NEW web page") preserves that boundary while
  opening the legitimate "news from MY feeds" use.
- No new dependency; no code-path logic changed (string only).
