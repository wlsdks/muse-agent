# Muse System-Prompt Architecture (adopted 2026-07-11, opus-designed / fable-reviewed)

Given: `packages/prompts/src/identity-core.ts` is Layer 0 — the ONE identity
source. This doc fixes how everything composes around it so the 14
hand-assembled prompt paths collapse into one seam. Companion:
`identity-prompt-plan.md` (the identity fix + battery).

## Canonical layer stack (every user-facing turn)

```
STABLE PREFIX (cached, byte-identical per session)
  L0 identity-core      buildIdentityCore(locale)            ~40 tok
  L1 personality        ~/.config/muse/persona.md OR default  ~60 tok
  L2 surface-role       SURFACE_ROLES[surface]                ~40 tok
  L3 behavioral-rules   grounding-abstention + memory-is-DATA + tool policy
  L4 provider-overlay   providerStablePrefix (model-family tone)
------------------- MUSE_CACHE_BOUNDARY (exactly ONE, always) --------------
  D1 personalization    user-model facts/prefs/vetoes/goals/playbook
  D2 tone-hints         per-channel + learned register (scope-aware)
  D3 active-context     date/time, calendar, inbox
  D4 retrieved          notes/grounding block (volatile scores)
  D5 tool-results
```

Stable iff byte-identical across the session; anything with a timestamp,
score, channel id, or tool output is dynamic. One marker policy — no surface
may special-case the boundary. Tone is output shaping, never identity;
shared-scope channels force neutral register and scope-filter D1 out.

## Decisions (rationale in the review record)

- **D1** One `composeSurfacePrompt(surface, parts, ctx)` seam
  (`packages/prompts/src/compose.ts`, `MuseSurface` enum, `SURFACE_ROLES`);
  delegates to the existing `buildLayeredSystemPrompt` + layer registry.
  Rejected: parallel per-surface builders sharing only a constant.
- **D2** `~/.config/muse/persona.md` (tone/personality ONLY; Zod frontmatter
  `register/maxWords/language`; body through neutralizeInjectionSpans +
  escapeSystemPromptMarkers at LOAD; invalid ⇒ default bluebird layer;
  file REPLACES L1). **No user-authored facts file** — hand-written facts
  are ungroundable citable text, a confident-lie vector; facts stay in the
  learned, decaying user-memory. Rejected: hermes-style USER.md.
- **D3** Uniform single-marker cache policy, mechanically tested.
- **D4** Personality + all future personalization blocks are registered
  `PromptLayer`s (id/priority/section/personaIds) — never string literals.
- **D5** Identity compact (≤60 tok ceiling) — verbose anti-leak disclaimers
  degrade 12B tool-calling; the identity battery is the proof, A/B-kept.

## Migration (no big-bang)

1. **Phase 1**: agent-core context-transforms base prompt → seam ("chat") —
   fixes CLI chat + /api/chat + channels at once; then `ask`.
2. **Phase 2**: today/brief + recall composeSystemPrompt override.
3. **Phase 3**: reflection/council/pattern/proactive/companion/tagline/
   planning surfaces.

## Guardrails (each ships with the migration slice that makes it true)

1. Per-surface prompt snapshot test (`compose.snapshot.test.ts`).
2. Identity-anchor presence test — identity block at position 0 of every
   surface's stable prefix.
3. Cache-boundary position test — exactly one marker; dynamic layers after,
   stable before.
4. `check:prompt-seam` drift lint (grep, like check:capabilities): outside
   identity-core/compose, `You are Muse|너는 뮤즈` or direct
   `buildSystemPrompt(` calls fail CI.
5. Per-layer token ceilings enforced in compose (throw in tests).
6. Grounding gates stay deterministic post-generation code — never in-prompt.

Future personalization blocks (tone-from-corrections, time-of-day brevity,
반말/존댓말 register) each land as: registry.register(layer) + snapshot +
one eval case. Zero new hardcoded identity strings, ever.

## S3 — user-manageable prompt surface (admin/web, 진안 2026-07-11)

The user-editable half gets first-class management + experimentation:

1. **Persona editor** (web console view): edit `~/.config/muse/persona.md`
   (frontmatter register/maxWords/language + body) with Zod validation and
   the injection scan running at SAVE time; invalid ⇒ rejected with the
   reason, never silently defaulted.
2. **Composed-prompt preview**: read-only view of the EFFECTIVE system
   prompt per surface (layer-colored: identity / personality / role / rules
   / boundary / dynamic) — transparency for trust and the starting point of
   every experiment. Identity-core renders read-only (system layer; the
   identity battery is its guard).
3. **A/B experiment runner**: one question → current persona vs draft
   persona side-by-side against the local model; save the winner. The
   12-probe identity battery is runnable from the UI (local-only).
4. API: GET/PUT /api/prompt/persona (scan-on-save), GET
   /api/prompt/preview?surface=…, POST /api/prompt/experiment (two-variant
   run). All local; no cloud egress.
