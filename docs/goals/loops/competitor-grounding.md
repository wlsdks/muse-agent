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

## fire 3 · 2026-06-20 · skill loop-creator v(substantial-fire) · (this commit) — span-level neutralization, ALL prose surfaces
meta: value-class=new-capability · pkg=@muse/recall · kind=security-hardening · verdict=PASS(Opus ④b judge, independent, mutation-checked) · firesSinceDrill=3 · surfaces=4
ratchet: testFiles 1053→1054 · fabrication 0 · recall 309→320 / cli build / lint / self-eval green
- 무엇: SUBSTANTIAL fire (진안 "fires too easy" 교정 후 첫 fire). New `neutralizeInjectionSpans` (span-level: replace only the matched injection SPAN, keep the rest of the prose) applied to ALL 3 prose surfaces — episodes, feeds, AND notes (the previously-deferred surface, now safe via span-level). Atomic facts keep whole-defang. Closes T1-a fully (4 surfaces).
- 왜: fire-2 Opus judge flagged whole-prose defang nuking a whole summary on one benign trigger ("forget about the previous vendor"). Span-level limits damage to the matched phrase; the rest of the recall content survives → unblocks the notes surface (user-authored prose now safe to scan).
- 리뷰지점: Opus judge PASS — substantial(4 surfaces, not sliver) + benign-prose-survives test + OUTCOME on assembled blocks + no ReDoS + atomic-fact path unchanged. Mutation-checked RED.
- 리스크: residual `^system:` start-anchored misses mid-prose `\nsystem:` (backlog T1-a-resid). MONOTONY: fires 1-3 all @muse/recall injection-hardening — fire 4 MUST move to a distinct lever (T1-b claim-health or T2 FTS5/SSRF), not a 4th injection repeat (Opus judge + VALUE-CLASS RATCHET both flag this).

## fire 4 · 2026-06-20 · skill loop-creator v(substantial-fire) · (this commit) — SCOPE CORRECTION (no code)
meta: value-class=scout/scope-correction · pkg=docs · kind=backlog-accuracy · verdict=PASS(honest audit, no code slice) · firesSinceDrill=4 · surfaces=0
ratchet: testFiles 1054 (unchanged) · fabrication 0 · baseline green
- 무엇: audited the top-2 Tier1/2 items before building. Found both NOT a clean substantial slice: T1-b (claim-health) is DATA-MODEL-BLOCKED (facts have no per-fact timestamp/evidence; only store updatedAt + factHistory for replaced facts) → DECOMPOSED into a prereq (per-fact provenance) + a feasible-now status unit. T2-b (SSRF guard) is ALREADY comprehensively built (web-url-guard.ts covers all ranges + metadata + IPv6 + DNS-rebinding, applied to every web tool + --url ingest) — the competitor survey was WRONG; marked ✓ with a feeds-fetch verify residual.
- 왜: the SUBSTANTIAL-FIRE rule forbids slivers, but the honest move when the top items are blocked/already-done is to CORRECT the backlog (DECOMPOSE-ON-DEFER + survey-error fix) rather than manufacture busywork or grind a degraded large fire at the tail of a very long session. Backlog accuracy stops the loop wasting future fires on a blocked item or re-building a done one.
- 리뷰지점: no code change — a deliberate scope-correction fire. The next fire has a clean substantial different-lever target: T2-d (skill curator + provenance, feasible/substantial) or T1-b-ii (claim STATUS via existing detectSourceConflict, no data-model dep). Monotony guard satisfied (moves off @muse/recall injection).
- 리스크: a no-code fire could read as "loop stalled" — it isn't; it's the contract's honest output when blocked. If several no-code fires recur, that signals the theme's easy veins are drying → widen the theme or pause.
