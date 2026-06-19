# Loop journal — competitor-grounding

Theme: competitor-adopted grounding-edge hardening + self-development, one verified slice/fire. Source: code-level survey of cloned openclaw + hermes (both MIT) vs Muse — both LACK a deterministic grounding gate (Muse's moat). Adopt PATTERNS only, re-implemented fresh in Muse's own TS. Backlog: `## ★ Open — competitor-adopted grounding hardening`. Cron 6c90833a (every 20m, session-scoped). Tier1 (local commits, never push).

## fire 1 · 2026-06-20 · skill loop-creator · 4f0b… (memory poisoned-source defang)
meta: value-class=new-capability · pkg=@muse/recall + @muse/cli · kind=security-hardening · verdict=PASS(deterministic; inline first-fire, no Opus judge) · firesSinceDrill=1
ratchet: testFiles 1053 · fabrication 0 · recall 306 / cli 2731 / lint / self-eval green
- 무엇: T1-a (memory-fact path). Shared `defangMemoryInjection` (@muse/recall/injection.ts) neutralizes an injection-shaped fact value at `renderMemoryFact` render time → ask-path memory block + conflict cue now defanged (was cli-persona-only). `muse-persona.ts` consolidated onto the shared single pattern source.
- 왜: poisoned-source / GROUNDED≠TRUE — the #1 known gap, and the axis BOTH competitors lack (they treat grounding as a prompt instruction). A fact poisoned at write time (malicious tool result/paste) must not steer the model when rehydrated; raw stays in the store (user can remove), prompt sees the neutralized form.
- 리뷰지점: patterns are narrow (a legit "always reply in Korean" passes); defang applies to the VALUE so the conflict cue sees the neutralized form too (good — a poisoned fact shouldn't manufacture conflicts).
- 리스크: notes/episodes threat-scan NOT yet covered (only markers escaped) — next fire. Inline first-fire skipped the Opus ④b judge (autonomous fires run it); deterministic gates (TDD red→green + OUTCOME proof + lint + self-eval) stood in.

## fire 2 · 2026-06-20 · skill loop-creator · (this commit) — episode + feed defang
meta: value-class=new-capability · pkg=@muse/recall · kind=security-hardening · verdict=PASS(Opus ④b judge, independent) · firesSinceDrill=2
ratchet: testFiles 1053 · fabrication 0 · recall 306→309 / cli 2731 / lint / self-eval green
- 무엇: extend `defangMemoryInjection` (fire-1 shared source) to EPISODE summaries + FEED headlines/summaries in present.ts — composed under the existing `escapeSystemPromptMarkers`. Both are non-user-authored untrusted text (auto-summaries / external RSS).
- 왜: memory flags "framing alone does NOT stop the 8B obeying embedded instructions" — so a deterministic defang (not just `<<feed>>` framing) is needed for the most-untrusted sources. Notes (user-authored) deferred — blanket defang would false-hide the user's own content.
- 리뷰지점: Opus judge PASS but flagged whole-prose false-defang (a benign episode containing a trigger word loses its whole summary) → span-level neutralization is the next-fire follow-up (logged in backlog T1-a ii).
- 리스크: whole-text defang precision on prose (rare false-hide of an augmentative episode; fail-toward-safe). VALUE-CLASS: fires 1+2 both @muse/recall security-hardening — next fire should change value-class or do the span-level precision fix, not extend the same defang again.
