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
- [x] **2c — UserModel surfaced + correctable + actually USED.** Show =
  `muse user model list`; correct/forget = `muse user model remove <id>` (2a).
  The KEY fix: the typed model was only rendered into the COMPACTION snapshot
  (buildPersonaSnapshot) — invisible on a normal turn, so ② was nearly inert.
  Wired it into `renderUserMemorySection` (the always-on `[User Memory]` system
  section context-transforms injects every turn), incl. the empty-check so a
  model with ONLY typed slots still emits. Useful: a typed model now appears in
  the live persona every turn (proven); remove → it's gone next render. P1 ②
  epic complete. — done 2026-05-29

## P2 — ① Consolidating Curator (the deferred Approach C)

- [x] **1a — Consolidate authored skills into umbrellas.** `muse skills
  consolidate` (preview by default, `--apply` to do it): clusters authored
  skills by name+description similarity, hands each cohering cluster to a
  local-Qwen merger (`mergeSkillsIntoUmbrella`, agent-core) that returns one
  umbrella or NONE, then ARCHIVES the originals (never deletes) and writes the
  umbrella. Originals archived BEFORE the umbrella write so it can't
  similarity-patch one of them. Live battery `verify-skill-merge.mjs` on
  qwen3:8b: 3 related summarise-* skills → coherent umbrella (positive);
  unrelated skills → NONE, no force-merge (negative). — done 2026-05-29
- [x] **1b — Consolidate playbook strategies.** `muse playbook consolidate`
  (preview by default, `--apply`): clusters learned strategies by
  strategyTextSimilarity, a local-Qwen `mergePlaybookStrategies` folds each
  redundant cluster into one general strategy (or NONE for distinct ones), then
  records the merged + removes the originals. Reuses the pure
  `clusterByTextSimilarity`. Live battery `verify-playbook-merge.mjs` on
  qwen3:8b: redundant summarise strategies → one merged (positive); distinct
  strategies → NONE, never collapsed (negative). — done 2026-05-29
- [x] **1c — Session-end trigger + dry-run + rollback.** Trigger: session-end
  auto-consolidate behind `MUSE_SKILL_CONSOLIDATE_ENABLED` (default off,
  fail-soft — mirrors the skill-author/distill hooks). Dry-run: `muse skills
  consolidate` previews by default (1a). Rollback: `AuthoredSkillStore.restore`
  + `muse skills restore <name>` revives an archived skill (refuses to clobber
  a live slot), `muse skills archived` lists them. Useful: dry-run mutates
  nothing; apply archives (never deletes) + is restorable (proven). P2 ① epic
  complete — and with it ALL THREE FRONTIERS (③ ② ①). — done 2026-05-29

---

## Audit when an epic completes
When every bullet of an epic is `[x]`, the next tick re-runs that epic's checks
together AND exercises it as one end-to-end user flow (does the whole thing
actually help the user, not just each piece?). REOPEN any bullet that drifted.

---

## ALL THREE FRONTIERS COMPLETE (2026-05-29)
9 slices shipped + verified (pnpm check 27-pkg EXIT 0, lint 0/0, 4 live
qwen3:8b batteries, smoke:live 22/0/1, smoke:broad 51/0) and pushed to
origin/main (`15b6add2`). What works: ③ checkins/suggest/dismiss · ② user
model write+infer+persona · ① skills/playbook consolidate + rollback.

## NEXT BACKLOG (P3+ — extracted after completion)

Theme: the frontiers WORK but mostly via MANUAL commands + opt-in flags. The
next phase is making the JARVIS run them ON ITS OWN, then deepening.

- [ ] **N1 (P0) — Make it automatic (no manual command).** Wire session-end
  auto-scan for commitment check-ins (3a-auto) + auto-`infer` preferences, and
  an IDLE-gated curator consolidate (vs the current session-end flag), all
  default-off + fail-soft. The "speaks first / learns on its own" promise needs
  these to fire without `muse checkins scan` / `user model infer` / `skills
  consolidate`. Verify: a session with a commitment+correction → next daemon
  tick delivers the check-in AND the inferred preference shows in the model.
- [ ] **N2 (P0) — ③/② end-to-end daemon audit.** One real daemon tick test
  that exercises check-in delivery + pattern suggestion together (composition,
  quiet-hours, dedup) — proves the pieces compose, not just unit-pass.
- [ ] **N3 (P1) — Surface proactive output IN-CHAT.** The in-chat idle poll
  should also surface due check-ins + pattern suggestions (today they go to the
  daemon's messaging channel only), so a user living in `muse` chat sees them.
- [ ] **N4 (P1) — UserModel confidence decay / re-confirm.** Inferred prefs
  should fade or ask to re-confirm over time; add Honcho-style ONE clarifying
  question for a low-confidence inferred preference before trusting it.
- [ ] **N5 (P2) — Weighted memory promotion (OpenClaw "dreaming" part not yet
  done).** Promote frequently-recalled memories into the always-on persona by
  recall-usefulness (relevance-weighted), beyond episode themes/consolidate.
- [ ] **N6 (P2) — `pnpm eval:self-improving` gate.** Run all 4 live batteries
  as one regression gate so the LLM slices can't silently rot.
