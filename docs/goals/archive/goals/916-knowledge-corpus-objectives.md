# Goal 916 — `knowledge_search` spans standing objectives (corpus source-completeness)

## Outward change

`knowledge_search` (the P20 RAG tool) now searches the user's live
standing objectives alongside notes, tasks, calendar, contacts,
emails, reminders, followups, and feeds. Ask "what am I working toward
on the Q3 memo?" and the matching objective is surfaced and cited
`[objective/Ship the Q3 memo once we have signoff]`. Before, the
corpus assembled every sibling intent store — reminders, followups,
tasks — but **omitted objectives entirely**, so a user's standing
goals (the highest-level "what I'm trying to accomplish" intent) were
invisible to the one tool meant to answer "what do I know / am I
pursuing about X".

## Why this, now

The exhaustive-list seam (export 904, scheduler-next 890, open-jobs
903): a catalog that should be complete but omits a recent store. The
objectives thread (884/890–894) surfaced objectives across status
(891), the muse.status tool (892), `muse open` (893), and scheduler-
next (890) — but the knowledge corpus, assembled from the sibling
stores, never got the objectives source. It's the last place the
user's standing intent wasn't reachable. Objectives are short,
high-signal statements of purpose — exactly what RAG should ground
"what am I doing about X" on.

## How

- `knowledge-corpus.ts`: new `ObjectiveLike` / `ObjectivesSource`
  interfaces + an `objectivesSource?` option; the assembly emits each
  objective as an `objective/<spec>` chunk (blank specs skipped,
  fail-open on a throwing source), exactly mirroring the
  reminders/followups blocks. The wrapper `NotesKnowledgeSearchToolOptions`
  + passthrough gained `objectivesSource`, and the tool description now
  lists "standing objectives".
- `index.ts`: wired `objectivesSource` to read
  `readObjectives(resolveObjectivesFile(env))` filtered to live intent
  (`active` / `escalated` — done/cancelled aren't live, matching how
  reminders pass only `pending` and followups only `scheduled`).

## Verification

`packages/autoconfigure` `knowledge-objectives-source.test.ts` (NEW;
`pnpm --filter @muse/autoconfigure test`, 269 passing): `assembleKnowledgeCorpus`
emits an `objective/<spec>` chunk per objective, skips a blank spec,
and degrades to no objective chunks on a throwing source; and
`knowledge_search` (with an injected deterministic embedder) answers a
"Q3 memo signoff" query from the objective and cites
`[objective/Ship the Q3 memo once we have signoff]`. Mutation-proven:
removing the objective-chunk push fails the corpus + search tests;
restored green. `pnpm check` green (autoconfigure 269, apps/cli 1661,
apps/api 323); `pnpm lint` 0/0. The corpus assembly is deterministic
(injected embedder) and the live-embedding mechanism is unchanged — no
new LLM round-trip, so no smoke:live (Ollama down regardless).

## Decisions

- Filtered to `active` + `escalated` (live intent), excluding
  done/cancelled — consistent with the reminders (`pending`) and
  followups (`scheduled`) sources: a completed/abandoned objective
  isn't live context.
- Sourced `objective/<spec>` (the human-readable goal text) via the
  shared `labelSource`, so a citation reads `[objective/Ship the Q3
  memo…]` rather than an opaque `obj_<uuid>`.
- Wiring fix: `resolveObjectivesFile` was re-exported by `index.ts` but
  not imported into its own scope (it lived only in the `export {…}
  from` block, not the `import {…}` block) — added it to the import
  block so the wiring compiles.
