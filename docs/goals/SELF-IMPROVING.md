# Self-improving JARVIS — the three frontiers

> The autonomous loop's standing target (replaces the saturated
> "competitor-mining"). North star: an agent that **improves itself**,
> **knows the user better over time**, and **speaks first with useful
> suggestions**. Build the slices below in priority order. Each slice is
> delivered ONLY when it (a) WORKS — green runnable check incl. a real local
> Qwen round-trip for any LLM path — AND (b) is demonstrably USEFUL — a live
> battery with a POSITIVE case (good output on real input) AND a NEGATIVE case
> (stays silent / declines, never fabricates). Tests-pass ≠ useful.

Safety rails (unchanged): suggestions/check-ins are surfaced to the USER on
their own channel, **draft-first**, never an autonomous third-party send;
banking out of scope; curator **archives, never deletes**; commit to
`competitor-mining`, FF-merge to main, never push.

Building blocks already in the tree (reuse, don't rebuild): `commitment-detector.ts`,
`chat-reflection.ts` (`synthesizeReflection`/`/reflect`), `playbook.ts`
(strategies), `authored-skill-store.ts` (curate/scan), pattern stores
(`pattern-firing-loop.ts`, `personal-patterns-fired-store.ts`,
`commands-pattern.ts`), the proactive daemon, `quiet-hours`.

---

## P0 — ③ Speak first with USEFUL suggestions (greenfield; neither competitor does this)

- [x] **3a — Due-windowed commitment check-ins.** `muse checkins scan` detects
  open-loops (`detectUserCommitments`) → schedules next-day, deduped,
  per-day-capped check-ins; the daemon's `checkinsTick` delivers due ones
  (templated, deterministic — can't fabricate), quiet-hours-aware, to the
  user's own channel. `muse checkins list` shows them. Useful: scheduleCheckins
  delivers a check-in for a real commitment + dedup/cap/not-due/quiet-hours all
  hold (positive+negative proven deterministically). FOLLOW-UP (3a-auto): wire
  session-end auto-scan so it speaks first without a manual `scan`. — done 2026-05-29
- [x] **3b — Behavior → proactive suggestion.** The pattern engine
  (`runDuePatternNotices`, was DORMANT — not wired to the daemon) now fires via
  a daemon `patternTick`, and each fireable pattern's suggestion is
  LLM-synthesized into a warm grounded offer (`synthesizePatternSuggestion`,
  the deferred "Phase D synthesis") with fail-soft fallback to the detector's
  verbatim text; quiet-hours-gated, cooldown'd, draft-first (offer, never
  auto-acts). Live battery `verify-pattern-suggestion.mjs` on qwen3:8b: strong
  weekly + time-of-day patterns → grounded offers naming the real recurring
  thing (positive); thin facts → NONE, no fabricated nag (negative). — done 2026-05-29
- [x] **3c — Suggestion dismissal → learned avoidance.** `muse pattern dismiss
  <id>` records a dismissal in the patterns-fired store (flag `dismissed`);
  `runDuePatternNotices` skips dismissed patterns forever, and a cooldown
  `reset` now PRESERVES dismissals (learned avoidance, not a timed cooldown).
  `muse pattern dismissed` lists them. Useful: a fired pattern, once dismissed,
  stays silent even with the cooldown cleared (proven). (Accept = acting on the
  offer is normal use; the named requirement was dismissal→no-recur.) — done 2026-05-29

## P1 — ② Know the user better (typed USER MODEL + inferred preferences)

- [x] **2a — Typed persistent UserModel.** The typed slot model
  (preference/schedule/veto/goal, confidence+updatedAt) was fully plumbed —
  composed into the persona by `composeUserModelSnapshot`, round-tripped by
  FileUserMemoryStore — but UNFILLABLE (the write path was "intentionally
  omitted"). Added the local-first write path: pure `upsertUserModelSlot`
  (replace-by-id) / `removeUserModelSlot` + the store mutators + `muse user
  model add/list/remove`. A saved slot now persists and renders in the next
  session's persona. Useful: store round-trip → findByUserId returns the slot →
  composeUserModelSnapshot emits it (proven). — done 2026-05-29
  (P0 ③ audit — checkins+pattern+dismiss all wired into the daemon runTick;
  full `pnpm check` green across their suites together — PASS, no drift.)
- [x] **2b — Behavior-inferred preferences (not just explicit "remember").**
  `muse user model infer` reads last-chat corrections (`detectCorrections`) →
  one local-Qwen `inferPreferenceFromCorrection` → a persona-level preference
  slot (category-keyed id `pref-<category>` so a changed mind SUPERSEDES, not
  duplicates) written via 2a's upsert. Distinct from the playbook distiller
  (task recipe) — this is WHO the user is. Live battery
  `verify-preference-inference.mjs` on qwen3:8b: EN+KO style corrections →
  grounded preferences (positive); a one-off factual fix → NONE (negative).
  HARDENING: the live negative case caught the model fabricating "prefers
  accurate information"; added a deterministic vacuous-trait guard
  (accuracy/correctness cluster + required category) so it can't. — done 2026-05-29
- [ ] **2c — UserModel surfaced + correctable.** `muse user model` (show) +
  the persona uses it; the user can correct/forget an inferred trait. Useful-check:
  correct an inferred trait → it updates, doesn't reappear.

## P2 — ① Consolidating Curator (the deferred Approach C)

- [ ] **1a — Consolidate authored skills into umbrellas.** A background/idle
  (or `muse skills consolidate`) review that MERGES overlapping authored skills
  into a class-level umbrella (improve description, archive originals — never
  delete), after Hermes' curator. One local-Qwen review over the authored set.
  Useful-check (live, positive+negative): 4-5 narrow related skills → 1 coherent
  umbrella; unrelated skills → untouched.
- [ ] **1b — Consolidate playbook strategies.** Same for near-duplicate learned
  `[Learned Strategies]` — merge/generalise, dedup. Useful-check: redundant
  strategies collapse; distinct ones stay.
- [ ] **1c — Idle/session-end trigger + dry-run + rollback.** Wire the curator
  to run idle-gated (or at session end behind a flag), with a dry-run preview
  and archive-restore. Useful-check: dry-run shows the plan and mutates nothing;
  apply consolidates + is restorable.

---

## Audit when an epic completes
When every bullet of an epic is `[x]`, the next tick re-runs that epic's checks
together AND exercises it as one end-to-end user flow (does the whole thing
actually help the user, not just each piece?). REOPEN any bullet that drifted.
