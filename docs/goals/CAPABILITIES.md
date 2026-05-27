# Capabilities — the loop's only success metric

Append-only inventory of **real, user-exercisable** Muse
capabilities. One line per capability: what the user can do, the
exact command/surface, and the executable check that proves it.

Rules (enforced by `.claude/rules/iteration-loop.md`):

- Every shipped outward goal MUST append exactly one new line here.
  The `<check>` MUST be a concrete automated test or smoke id that
  actually runs green under `pnpm check` / `pnpm smoke:broad` /
  `pnpm smoke:live` and asserts the *capability* end-to-end (not
  that code compiles). Prose with no runnable id is not a check.
- **Cross-time falsification:** every iteration's first action is
  to run the newest line's check and prove it still passes. A
  faked/broken line = the next iteration's whole job is to fix it.
- **Regression sweep:** every 10th iteration re-runs ALL checks;
  any regression = next iteration must restore it.
- A request/response-path capability whose `smoke:live` did NOT
  actually run is tagged `[UNVERIFIED-LIVE]`; it does not count
  until a later iteration runs the live check and drops the tag.
- Append-only. Never delete or weaken a line.
- **The success metric is NOT this line count.** It is
  `OUTWARD-TARGETS.md` bullets flipped `[ ]`→`[x]`. A line here is
  the *evidence* for a flip (cite the bullet it delivers); a line
  that adds no bullet flip is thin and does not satisfy the metric.
  No bullet flipped in the last 5 iterations ⇒ next iteration's
  sole mandate is to flip one end-to-end. Flat bullets =
  degeneration; act on it — never stop, never ask a human.

Format: `- [<axis>] <capability> — <command/surface> — <runnable check id> — P<n> bullet`
axis ∈ Reach | Anticipation | Autonomy | Presence

## Inventory

P0–P21's full verified ledger is preserved in
`archive/CAPABILITIES-through-2026-05-27.md` (human reset
2026-05-27 to keep the loop-facing file lean — history intact, not
deleted). The lines below are the delivered foundation that the
active P22 target extends; new P22 lines append here.

- [Anticipation] Proactive notice loop (upcoming events / reminders) — `apps/api` proactive daemon tick — `apps/api` proactive-tick tests
- [Anticipation] Self-queued follow-up promises fire later — followups daemon tick — `runDueFollowups` tests
- [Autonomy] Standing-objective evaluation fires its actuator — objectives daemon tick — `runDueObjectives` tests
- [Anticipation] Ambient OS signal drives a proactive notice — `runAmbientNoticeTick` + `MacOsActiveWindowSource` — ambient-notice-loop tests
- [Anticipation] Page-change web-watch fires an edge-triggered notice — `createWebWatchRunner` (HTTP + Chrome source) — web-watch-runner / web-watch-chrome tests
- [Anticipation] Proactive notice delivered to a real channel — `ProactiveNoticeSink` over the messaging registry (Telegram) — `sendWithRetry` + proactive-notice-loop tests
- [Presence] Episode forgetting is now importance-aware — a pivotal old session resists being vacuumed away while a trivial recent one fades (FadeMem, arXiv 2601.18642: biologically-inspired forgetting, decay modulated by importance) — `vacuumEpisodes` dropped purely-oldest-by-`endedAt` at the cap; now `computeEpisodeRetention` scores each episode `exp(-ageDays / (halfLife·(1 + w·importance/10)))` so importance EXTENDS the half-life (importance-10 ⇒ ~3× slower fade), and `selectRetainedEpisodes` keeps the highest-retention `cap` (newest-then-id tie-break). Back-compatible: an UNSCORED corpus reduces to recency ordering, so chronological vacuum is byte-identical until importance is present — `@muse/mcp` episode-retention.test.ts (age decay; importance slows fade; unscored→recency; unparseable→0; importance tips comparable ages: a 35-day importance-10 session out-retains a 25-day importance-1 one at the cap; deterministic ties) + existing vacuum suite stays green (unscored episodes still pruned oldest-first) — research-applied slice (no new dep, deterministic/local; builds on the importance arc)
- [Presence] Auto-extracted memory now resolves each fact with an explicit operation instead of blind-overwriting (Mem0, arXiv 2504.19413: per-candidate ADD/UPDATE/DELETE/NOOP) — `classifyMemoryOperation(existing, incoming)` is deterministic over the extractor's output (no extra model call): NOOP when a value re-confirms what's stored → SKIPS the redundant write + provenance entry (a re-mention no longer logs a fresh "learned" event); DELETE when the value is a no-value/retraction token (none/n/a/unknown/없음/모름/…) → the key is FORGOTTEN via the store's `forget` instead of storing junk like "unknown"; ADD/UPDATE upsert + record provenance as before; the auto-extract persist reads existing memory once and routes each fact/preference through it — `@muse/memory` memory-operation.test.ts (classifier: add/noop/update/delete EN+KO tokens; auto-extract integration: re-confirm → no new provenance, changed → upsert+provenance, retraction → key forgotten) + full memory suite 213 green (new facts still ADD as before, back-compatible) — research-applied slice (arXiv id cited in code; deterministic, no new dep, no extra LLM call)
