# 472 — voice registry unknown-id error names the registered providers (actionable error UX)

## Why

`VoiceProviderRegistry.requireStt(id)` / `requireTts(id)`
(`@muse/voice` `registry.ts`) threw a **dead-end** message:
`STT provider not registered: <id>` — with no indication of what
*is* registered. This is the resolution point the voice API uses:
`apps/api/src/voice-routes.ts` calls `gate.registry.requireStt
(providerId)` / `requireTts(providerId)`, so a typo'd or
unconfigured `providerId` in a voice request surfaces this
message to the API caller with **no recovery path** — they
cannot tell whether they fat-fingered the id or the provider
simply was not configured.

Every other "not found by id" surface in the codebase already
gives an actionable hint (the `closestCommandName` "did you
mean", `muse actions --result` hint, feeds-id suggestion); the
voice registry was the inconsistent dead-end. Naming the
registered ids is the minimal, established-pattern fix. This is
an error-UX refinement in a fresh package (`@muse/voice`),
deliberately distinct from the recent apps/cli /
numeric-parse-hardening run (Step 8 redirect).

The existing `requireStt`/`requireTts` test only asserted
`toThrow(VoiceProviderError)` (not the message text), so the
enriched message introduces **no wrong premise**; the
recoverability of the error was genuinely untested.

## Slice

- `packages/voice/src/registry.ts` — `requireStt`/`requireTts`
  append a `registeredHint([...map.keys()])`:
  ` (registered: a, b)` when providers exist, ` (none
  registered)` when the registry is empty. The
  `VoiceProviderError` **code is unchanged**
  (`STT_NOT_FOUND` / `TTS_NOT_FOUND`) — only the human message
  is enriched, so any code branching on the code (or the
  existing `toThrow(VoiceProviderError)` assertion) is
  unaffected.
- `packages/voice/test/voice.test.ts` — extended the existing
  `VoiceProviderRegistry` describe (the prior 2 tests
  untouched): an empty registry → `/none registered/`; a
  populated registry → a typo'd id (`openai-wisper`,
  `opena-tts`) → `/registered: openai-whisper/` /
  `/registered: openai-tts/`.

## Verify

- New test green; the 2 pre-existing registry tests still green
  (no wrong premise — neither asserted the message text); full
  `@muse/voice` suite green (70, +1, 0 failed); tsc strict
  (voice) EXIT=0.
- **Clean-mutation-proven** (Edit-based): neutralising
  `registeredHint` to `""` makes the new test fail with the
  precise pre-fix symptom (`expected [Function] to throw error
  matching /none registered/ but got 'STT provider not
  registered: whisper'` — the old dead-end message) while the
  pre-existing registry tests stay green; fix restored, suite
  back to green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure registry logic — no LLM / model request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A voice request (or config) that names an unknown STT/TTS
provider now gets `… not registered: x (registered: a, b)` —
the caller immediately sees the valid ids and whether the
provider was simply not configured. The voice registry now
matches the codebase-wide actionable-error convention. Error
codes and all success paths are unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an error-UX `fix:` on an existing
feature, recorded honestly with this backlog row — not a false
metric.

## Decisions

- Enriched the message, kept the error **code**: callers that
  branch on `STT_NOT_FOUND`/`TTS_NOT_FOUND` (and the existing
  test) must not break — the recovery hint belongs in the human
  string only.
- Scoped to the voice registry only. The identical dead-end
  pattern exists in sibling registries (`@muse/calendar`
  `registry.ts`, `@muse/mcp` tasks/notes providers,
  `@muse/messaging` `registry.ts`) — a real cross-cutting
  actionable-error gap, but folding four packages into one
  commit violates tight-scope / risks Step-8 over-broad churn.
  Deferred to a future iteration via a README Rejected-ledger
  line so the discovery is not lost.
