# 773 — feat: wire the live knowledge enricher into the briefing daemon (anticipation, end-to-end)

## Why

772 gave the briefing the ABILITY to surface a related note (via an
injected `relatedKnowledge` enricher), proven with a fake. This builds
the REAL enricher from the user's live corpus and injects it into the
running situational-briefing daemon — so the proactive brief actually
says "Acme meeting in 30 min — your note: bring the Q3 deck."

## Slice

- `@muse/autoconfigure` `createKnowledgeEnricher({ notesProvider,
  tasksProvider, calendarSource, contactsSource, embed, minScore })` —
  returns a `(query) => Promise<string | undefined>` that assembles
  the unified corpus, cosine-ranks for the query, and returns ONE
  compact `[source] text` line for the best match above threshold
  (default 0.2 — surfaced unasked, so it must be relevant), or
  `undefined`. Reuses `assembleKnowledgeCorpus` + `rankKnowledgeChunks`.
  `createOllamaEmbedder` is now exported from the package.
- `situational-briefing-tick.ts` forwards `relatedKnowledge` to
  `runDueSituationalBriefing`.
- `startSituationalBriefingDaemonIfConfigured` builds the enricher
  (gated `MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED`) from the daemon's
  notesDir / tasksFile / calendar registry / contacts file, wrapped in
  the caching embedder, and injects it.

## Verify

- `@muse/autoconfigure` knowledge-enricher.test.ts (new, 3): against a
  REAL `LocalDirNotesProvider` + a fake embed, `createKnowledgeEnricher`
  returns `[notes/acme.md] …` for a matching query, `undefined` below
  threshold, `undefined` for an empty query.
- `@muse/api` situational-briefing-tick-related.test.ts (new, 1): the
  tick forwards a `relatedKnowledge` enricher → the brief delivered
  through a real `MessagingProviderRegistry` contains the
  `Related: [notes/acme.md] …` line.
- **Mutation-proven**: dropping the `[source]` prefix from the
  enricher's compact line fails its test; restore → 3/3.
- Full `pnpm check` EXIT 0 (autoconfigure 192, apps/api 313, every
  workspace green); `pnpm lint` 0/0. The daemon's enricher uses the
  real Ollama embedder at runtime; the tests drive the real
  assemble→rank→render + tick→loop paths with a fake embed /
  contract-faithful registry → no `smoke:live`.

## Decisions

- **Reuse the unified corpus + cached embed** — the enricher and
  `knowledge_search` share the same corpus assembly + ranking, so the
  related-note surfacing is exactly what a manual search would find.
- **Opt-in (`MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED`, default off)** —
  it embeds the corpus each brief (cached); enable it deliberately
  like the other embedding features. No bullet flip — completes the
  772 anticipation×knowledge capability as a live, running feature
  (CAPABILITIES line).
