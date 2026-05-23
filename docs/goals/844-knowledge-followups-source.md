## 844 — feat: knowledge_search spans scheduled followups (corpus now complete)

## Why

841 added pending reminders to the multi-document knowledge corpus,
leaving followups (the agent's own scheduled "check on X later") as the
last personal store NOT searchable. A user asking "anything about the
Acme deal?" wouldn't surface a tracked followup "follow up on the Acme
contract renewal." This closes the gap so the corpus spans EVERY
personal store: notes, tasks, calendar, contacts, email, reminders, and
now followups.

## Slice — symmetric to 841 (one new source)

`@muse/autoconfigure` knowledge-corpus.ts:
- `FollowupLike { id, summary }` + `FollowupsSource { list() }`
  (scheduled/still-pending followups only — fired/cancelled aren't live
  context).
- `assembleKnowledgeCorpus` emits each as a `followup/<summary>` chunk
  (human-labelled via the 830 `labelSource`; summary = chunk text).
  Fail-open (a throwing source → no followup chunks).
- Threaded through `createNotesKnowledgeSearchTool` and wired in the
  assembly: `followupsSource` reads the live followups file
  (`readFollowups` filtered to `status === "scheduled"`).

## Verify

`@muse/autoconfigure` knowledge-followups-source.test.ts (3):
- a scheduled followup becomes a `followup/<summary>` chunk;
- a throwing followups source degrades to zero followup chunks (corpus
  never crashes);
- **end-to-end**: `createNotesKnowledgeSearchTool` answers "anything
  about the acme contract renewal?" and cites `[followup/Follow up on
  the Acme contract renewal]` (real embed-ranked corpus, fake source).
- **Mutation-proven**: dropping the followup chunk push fails the emit
  + cite tests. `@muse/autoconfigure` 233/233, `pnpm lint` 0/0. (Full
  `pnpm check` shows ONLY the known voice-playback `/tmp` flake — 0
  non-voice failures.) The `knowledge_search` tool's name/schema are
  unchanged (only corpus content grows) → no smoke:live.

## Decisions

- **Scheduled followups only** — a fired/cancelled followup is no longer
  live context; including it would surface stale tracking.
- Completes the corpus source set (notes/tasks/calendar/contacts/email/
  reminders/followups) — `knowledge_search` now recalls from every
  personal store. CAPABILITIES line under P20 knowledge depth (no
  bullet flip).
