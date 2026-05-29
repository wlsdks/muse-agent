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
- [ ] **3b — Behavior → proactive suggestion.** From recurring signals
  (tasks/episodes/activity patterns) generate a concrete suggestion
  ("월요일마다 X 하시던데 먼저 해둘까요?") — one local-Qwen synthesis, draft-first
  (never auto-acts), surfaced in daemon/chat, cooldown'd so it never nags.
  Useful-check (live, positive+negative): a genuine weekly pattern → a grounded
  suggestion; noise / no pattern → silent (no fabricated nag).
- [ ] **3c — Suggestion acceptance loop.** The user can accept/dismiss a
  suggestion; a dismissal feeds learned-avoidance so the same suggestion
  doesn't recur (reuse veto-avoidance). Useful-check: dismiss once → not
  re-surfaced.

## P1 — ② Know the user better (typed USER MODEL + inferred preferences)

- [ ] **2a — Typed persistent UserModel.** A structured, provenance-+confidence
  bearing model (identity, preferences, communication style, recurring
  patterns) persisted and injected into the persona — distinct from the flat
  user-memory fact list. Refines (supersede, don't duplicate) over sessions.
  Useful-check: a taught fact + an observed preference both appear in the model
  and the next-session persona.
- [ ] **2b — Behavior-inferred preferences (not just explicit "remember").**
  One local-Qwen distill over corrections/behavior → a preference with
  confidence, written to the UserModel; a contradiction supersedes (with
  validity) rather than blindly appending. Useful-check (live, positive+negative):
  a real behavioral signal → a correct inferred preference; ambiguous/no signal
  → nothing inferred (no fabricated trait).
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
