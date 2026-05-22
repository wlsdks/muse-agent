# 772 — feat: the briefing proactively surfaces a related note for what's next (anticipation × knowledge)

## Why

The situational briefing surfaced tasks / calendar / weather / inbox —
but never the thing the user already WROTE that bears on what's
coming. A JARVIS-class anticipation: "Acme meeting in 30 min — your
note: bring the Q3 deck." This joins the imminent-context (P20
perception / anticipation) with the personal knowledge corpus (P20
knowledge) — proactively surfacing what you need to KNOW for what's
next, not just what's scheduled.

## Slice

`@muse/mcp`:
- `SituationalBriefingInput.related?` + `composeSituationalBriefing`
  renders a `Related: …` line (supplementary, same posture as
  weather/inbox — rides an otherwise-non-empty brief, never triggers
  one).
- `RunDueSituationalBriefingOptions.relatedKnowledge?` — an injected
  enricher `(query) => string | undefined`. When set + there's an
  imminent item, `runDueSituationalBriefing` calls it with the TOP
  (earliest) upcoming item's title and adds the returned line.
  Fail-soft: a thrown / empty lookup omits the line, never breaks the
  brief. The enricher is injected the same way `emailProvider` /
  `weatherProvider` are, so `@muse/mcp` stays free of the
  knowledge-corpus dependency.

## Verify

- `@muse/mcp` situational-briefing-related.test.ts (new, 4):
  `composeSituationalBriefing` renders `Related:` when set / omits it
  when unset; `runDueSituationalBriefing` calls the enricher with the
  top imminent item's title ("Acme strategy meeting") and the
  delivered message (real `MessagingProviderRegistry` + capturing
  provider) contains the `Related:` line; a THROWING enricher still
  delivers the brief without a Related line (fail-soft).
- **Mutation-proven**: removing the `Related:` line emission in
  `composeSituationalBriefing` fails the compose + loop tests; restore
  → 4/4.
- Full `pnpm check` EXIT 0 (mcp 704, every workspace green); `pnpm
  lint` 0/0. Contract-faithful injected enricher + real registry/
  capturing provider — no model path → no `smoke:live`.

## Decisions

- **Injected enricher, not a corpus dependency in `@muse/mcp`** —
  keeps the enforced dep boundary (`@muse/mcp` ⊄ knowledge corpus);
  the briefing only calls a `(query) => line` function, exactly like
  the weather/email providers it already takes.
- **Top imminent item only** — the brief stays terse; one
  related-note per brief, for the nearest thing. Supplementary, never
  a trigger. The live-corpus enricher (build from
  `assembleKnowledgeCorpus` + the cached embedder, inject in the
  apps/api briefing daemon, env-gated) is the thin follow-on wiring.
