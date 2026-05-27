# 774 — feat: ambient notices surface related knowledge too (anticipation on both proactive channels)

## Why

773 made the SCHEDULED briefing surface a related note for what's
imminent. The other proactive channel — the REAL-TIME ambient notice
(switching to the Acme tab fires "On the Acme doc") — didn't surface
what the user already wrote about what they're looking at. Completing
"proactive knowledge surfacing" means both channels do it.

## Slice

- `@muse/mcp` `createAmbientNoticeRunner` gains an optional injected
  `enrich(query)`: on a rising-edge notice it appends a `— Related: …`
  line keyed on the ambient signal (`window ?? app ?? selected`),
  called once per tick (only when something fires), fail-soft. Stays
  free of the knowledge-corpus dep (the enricher is injected).
- `apps/api`: `startAmbientTick` forwards `enrich`; a shared
  `buildKnowledgeEnricherIfEnabled(env, options)` helper (extracted
  from the 773 briefing wiring — now used by BOTH daemons) builds the
  live enricher (unified corpus + cached Ollama embed), and
  `startAmbientDaemonIfConfigured` injects it. Gated by the same
  `MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED`.

## Verify

- `@muse/mcp` ambient-notice-enrich.test.ts (new, 3): a firing notice
  gains `— Related: [notes/acme.md] …` keyed on the window
  ("Acme — Q3 Strategy"); no related line when the enricher returns
  undefined; a THROWING enricher still delivers the notice (fail-soft).
  Prior runner tests still 2/2 (enrich is optional).
- `@muse/api` ambient-tick-enrich.test.ts (new, 1): `startAmbientTick`
  forwards the enricher → the notice delivered through a real
  `MessagingProviderRegistry` contains the Related line. The 773
  briefing daemon test still passes after the helper extraction.
- **Mutation-proven**: dropping the `— Related:` append in the runner
  fails the enrich test; restore → 3/3.
- Full `pnpm check` EXIT 0 (mcp 707, apps/api 314, every workspace
  green); `pnpm lint` 0/0. Injected enricher + real registry / fake
  embed — no model path → no `smoke:live`.

## Decisions

- **Key the ambient lookup on what the user is LOOKING at**
  (`window ?? app ?? selected`) — "you switched to the Acme doc →
  here's your Acme note" is the real-time anticipation; the briefing
  keys on the imminent item's title (scheduled). Two channels, two
  natural keys, one shared enricher.
- **Shared `buildKnowledgeEnricherIfEnabled` helper** — DRY across the
  briefing (773) and ambient daemons; one gate, one corpus+embed
  build. No bullet flip — completes P20 anticipation×knowledge on the
  ambient channel (CAPABILITIES line).
