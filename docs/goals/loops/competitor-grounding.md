# Loop journal — competitor-grounding

Theme: competitor-adopted grounding-edge hardening + self-development, one verified slice/fire. Source: code-level survey of cloned openclaw + hermes (both MIT) vs Muse — both LACK a deterministic grounding gate (Muse's moat). Adopt PATTERNS only, re-implemented fresh in Muse's own TS. Backlog: `## ★ Open — competitor-adopted grounding hardening`. Cron 6c90833a (every 20m, session-scoped). Tier1 (local commits, never push).

## fire 1 · 2026-06-20 · skill loop-creator · 4f0b… (memory poisoned-source defang)
meta: value-class=new-capability · pkg=@muse/recall + @muse/cli · kind=security-hardening · verdict=PASS(deterministic; inline first-fire, no Opus judge) · firesSinceDrill=1
ratchet: testFiles 1053 · fabrication 0 · recall 306 / cli 2731 / lint / self-eval green
- 무엇: T1-a (memory-fact path). Shared `defangMemoryInjection` (@muse/recall/injection.ts) neutralizes an injection-shaped fact value at `renderMemoryFact` render time → ask-path memory block + conflict cue now defanged (was cli-persona-only). `muse-persona.ts` consolidated onto the shared single pattern source.
- 왜: poisoned-source / GROUNDED≠TRUE — the #1 known gap, and the axis BOTH competitors lack (they treat grounding as a prompt instruction). A fact poisoned at write time (malicious tool result/paste) must not steer the model when rehydrated; raw stays in the store (user can remove), prompt sees the neutralized form.
- 리뷰지점: patterns are narrow (a legit "always reply in Korean" passes); defang applies to the VALUE so the conflict cue sees the neutralized form too (good — a poisoned fact shouldn't manufacture conflicts).
- 리스크: notes/episodes threat-scan NOT yet covered (only markers escaped) — next fire. Inline first-fire skipped the Opus ④b judge (autonomous fires run it); deterministic gates (TDD red→green + OUTCOME proof + lint + self-eval) stood in.
