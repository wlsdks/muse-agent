# @muse/prompts

Muse's system-prompt builder and surface-specific prompt composers: identity, capability
description, and per-surface (chat, planning, today-brief) prompt assembly. It is a package
because the builder (`system-prompt.js`), the surface composer (`compose.js`), and the
prompts that call the composer (`surface-prompts.js`) form a layered dependency the barrel
must not re-form into a cycle — kept as one package so that layering is enforceable.

## Public surface

- `system-prompt.js` — the core system-prompt builder (the leaf module every composer uses).
- `composeIdentityPrompt`, `MUSE_IDENTITY_CORE`, `MUSE_IDENTITY_LEAD` — Muse's identity block.
- `describeCapabilities`, `describeCapabilitiesEn`, `describeCapabilitiesKo` — bilingual
  capability description for the system prompt.
- `composeSurfacePrompt`, `composeSurfacePromptSegments`, `SURFACE_ROLES`, `MuseSurface`,
  `COMPANION_PERSONA_TEXT`, `TAGLINE_PERSONA_TEXT` — per-surface prompt composition.
- `buildPlanningSystemPrompt`, `buildTodayBriefUserMessage`, `TODAY_BRIEF_SYSTEM_PROMPT` — the
  planning and today-brief surface prompts built on top of the composer.
- `exemplar-retriever.js` — few-shot exemplar retrieval for prompt assembly.

## Depends on

This package declares no internal `@muse/*` dependencies — it is a leaf that only the runtime
layers (`agent-core`, `recall`, `autoconfigure`) depend on, never the reverse.

## Rules that bind this package

- [`../../.claude/rules/code-style.md`](../../.claude/rules/code-style.md) — this barrel is deliberately logic-free (re-exports
  only) so `compose.js` cannot import back through it and re-form a runtime import cycle.

## Tests

```bash
pnpm --filter @muse/prompts test
```
