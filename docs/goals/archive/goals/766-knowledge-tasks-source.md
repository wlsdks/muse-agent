# 766 — feat: knowledge_search spans the user's tasks, not just notes (P20 knowledge)

## Why

`knowledge_search`'s corpus was notes-only. But a daily-driver's key
facts often live in TASKS — "Acme contract due Friday", "renew the
domain". A unified semantic search across notes + tasks is the genuine
"multi-source personal corpus" P20 knowledge calls for; without tasks,
asking "when's the Acme deadline?" misses the todo that holds it.

## Slice

`@muse/autoconfigure` knowledge-corpus.ts:
- `assembleKnowledgeCorpus` gains an optional `tasksProvider`: each
  OPEN task becomes a `task/<id>` chunk (`title` + `notes`). Done
  tasks are excluded (noise). Fail-open if the store can't list.
- `createNotesKnowledgeSearchTool` accepts a `tasksProvider` (notes
  now optional) and the assembly passes `tasksRegistry.primary()`
  alongside the notes provider when `knowledge_search` is enabled — so
  the live tool searches notes + tasks together.

## Verify

- `@muse/autoconfigure` knowledge-tasks-source.test.ts (new, 2)
  against a REAL `LocalFileTasksProvider` (temp file, seeded via
  `.add()` / `.complete()`):
  - corpus emits `task/t1` (`title` + `notes`) for an OPEN task and
    EXCLUDES a completed task (`task/t2`).
  - end-to-end `knowledge_search("when is the acme contract due?")`
    answers from the open task and cites `task/t1` ("due Friday").
- Existing knowledge tests still green (notes-only path unchanged, 6/6).
- **Mutation-proven**: changing the task list filter from `"open"` to
  `"all"` leaks the done task → the exclusion test fails; restore →
  2/2.
- Full `pnpm check` EXIT 0 (autoconfigure 181, every workspace green);
  `pnpm lint` 0/0. Real tasks store + deterministic fake embed — no
  model request/response path → no `smoke:live`.

## Decisions

- **Open tasks only** — done tasks are mostly noise for "what do I
  need to know now"; a completed-task fact ("paid the invoice") is
  better recalled via notes/episodes. Keeps the corpus focused.
- **`task/<id>` source label** — distinct from `notes/<id>` so a cited
  answer says WHICH store the fact came from. No bullet flip — P20
  knowledge is already `[x]`; this widens the corpus to a second live
  source (CAPABILITIES line). Calendar / contacts are natural further
  sources, follow-on.
