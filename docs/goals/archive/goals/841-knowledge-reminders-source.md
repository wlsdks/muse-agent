## 841 — feat: knowledge_search spans pending reminders

## Why

The multi-document knowledge corpus (P20) spanned notes, open tasks,
calendar, contacts, and recent email — but NOT reminders. A reminder is
literally the user telling Muse "remember X" ("renew passport", "call
the dentist"); if that fact lives only as a reminder (not also a note
or task), `knowledge_search` couldn't recall it ("anything about the
dentist?" → nothing). That's a real recall gap in the personal corpus.

## Slice — one new corpus source (single package)

`@muse/autoconfigure` knowledge-corpus.ts:
- `ReminderLike { id, text, dueAt? }` + `RemindersSource { list() }`
  (pending reminders only — fired/cancelled aren't live context).
- `assembleKnowledgeCorpus` emits each as a `reminder/<text>` chunk
  (human-labelled via the 830 `labelSource`), text = "`<text>` (due
  `<dueAt>`)" so the due date is searchable/citable. Fail-open like the
  other sources (a throwing reminders source → no reminder chunks).
- Threaded through `createNotesKnowledgeSearchTool` and wired in the
  autoconfigure assembly: `remindersSource` reads the live reminders
  file (`readReminders` filtered to `status === "pending"`), so the
  opt-in `knowledge_search` tool now spans reminders too.

## Verify

`@muse/autoconfigure` knowledge-reminders-source.test.ts (3):
- a pending reminder becomes a `reminder/<text>` chunk carrying its
  text + "due `<dueAt>`";
- a throwing reminders source degrades to zero reminder chunks (corpus
  never crashes);
- **end-to-end**: `createNotesKnowledgeSearchTool` answers "anything
  about the dentist?" from the reminder and cites
  `[reminder/Call the dentist]` (real embed-ranked corpus, fake
  source).
- **Mutation-proven**: dropping the reminder chunk push fails the emit
  + cite tests; dropping the "(due …)" suffix fails the dueAt
  assertion. `@muse/autoconfigure` 230/230, `pnpm check` EXIT 0, `pnpm
  lint` 0/0. The `knowledge_search` tool's name/schema/selection are
  unchanged (only the corpus content grows) → no smoke:live.

## Decisions

- **Pending reminders only** — a fired/cancelled reminder isn't live
  context the user is asking about; including them would surface stale
  "remember X" facts that no longer apply.
- **Cite by the reminder text** (via `labelSource`, like 830) so the
  citation reads `[reminder/Renew passport before the trip]`, not an
  opaque id. Followups (the agent's own self-tracking) are a parallel
  store left for a follow-on; reminders are the user-authored, higher-
  value source. CAPABILITIES line under P20 knowledge depth (no bullet
  flip — extends the existing multi-doc RAG corpus).
