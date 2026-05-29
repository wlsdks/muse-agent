# Background-Review Engine — Muse's unified "complete the answer, then learn"

> Status: DESIGN (for review). Target: unify Muse's scattered post-turn
> learning into ONE engine with intelligent triggers, after Hermes-agent's
> `background_review.py`. Local-first, fail-soft, answer-never-blocked.

## 1. Why this exists (the gap we dropped)

The 2026-05-28 competitor study named four things Muse lacked vs.
Hermes/OpenClaw. Three shipped (skill authoring, curator/consolidate,
commitment check-ins). The fourth — **a unified background-review engine** —
never did. Instead the pieces accreted as *independent* hooks, each with its
own flag, its own trigger, its own re-read of the conversation:

| Learning mechanism | Where it runs today | Trigger today | Surface |
|---|---|---|---|
| Auto-memory extraction (facts/prefs/vetoes/goals) | `afterComplete` HookStage (`createUserMemoryAutoExtractHook`) | EVERY turn + 60s/user cooldown | server + CLI (shared runtime) |
| Correction → playbook strategy (ReasoningBank) | CLI session-end block | `MUSE_PLAYBOOK_DISTILL_ENABLED` | **CLI only** |
| Skill authoring (correction → SKILL.md) | CLI session-end block | `MUSE_SKILL_AUTHOR_ENABLED` | **CLI only** |
| Preference auto-infer (N1b) | CLI session-end block | `MUSE_PREFERENCE_AUTOINFER_ENABLED` | **CLI only** |
| Check-in auto-scan (N1a) | CLI session-end block | `MUSE_CHECKINS_AUTOSCAN_ENABLED` | **CLI only** |
| Skill consolidate (N1c) | idle daemon (apps/api) | `MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED` | server idle |
| Recall-hit promotion / "dreaming" (N5) | manual `muse memory promote` | manual | CLI |

Three problems fall out:

1. **No intelligent triggers.** Memory fires every turn (cooldown-bounded);
   everything else fires only at *session end* — but a continuous-companion
   session rarely "ends", and on the **server** there is no session-end at all,
   so skill/playbook/preference/check-in learning **never happens for the
   API/daemon surface**. The richest signal Hermes uses — *a HARD task
   (many tool iterations) should teach a skill NOW, mid-session* — is absent.
2. **N-way fragmentation.** Each mechanism re-reads the conversation, re-judges
   independently, has its own flag. There is no single "what did I learn this
   turn, what should persist?" pass, so judgments can't share context or
   de-conflict (e.g. a correction becomes BOTH a playbook strategy AND a skill
   patch with no coordination).
3. **CLI-only learning.** The most valuable distillers are wired in
   `chat-ink` session-end, invisible to every non-CLI surface that shares the
   same `agent-core` runtime — a direct violation of "server and CLI share the
   same runtime, same contracts."

## 2. Reference: how Hermes does it (read from source, 2026-05-29)

`agent/background_review.py` + `agent/conversation_loop.py` +
`agent/curator.py`:

- **Answer first, learn after.** After the final response is delivered (and
  only if `not interrupted`), the runtime MAY spawn a **daemon-thread forked
  agent** that replays the conversation snapshot and asks "should any
  memory/skill be saved or updated?". The fork inherits the live provider/model
  (same prefix cache, same auth) but runs under a **tool whitelist** limited to
  memory + skill tools — everything else is denied at runtime. The main
  conversation and prompt cache are never touched.
- **Two triggers, two channels:**
  - *Memory* — turn-count: `_turns_since_memory >= _memory_nudge_interval`
    (every N user turns). Captures persona/preferences/situation.
  - *Skill* — tool-iteration-count: `_iters_since_skill >= _skill_nudge_interval`
    (accumulates tool iterations across turns; `_iters_since_skill += 1` per
    tool loop). **Hard tasks teach**: a task that took many tool iterations
    trips the skill review sooner than a trivial chat turn. Counters persist
    across turns and reset on fire.
- **Rich persist policy (the prompt):** save persona/preferences/expectations
  to memory; for skills be *ACTIVE* (most sessions yield ≥1 update), prefer
  PATCH-loaded-skill > patch-umbrella > add-support-file > new class-level
  umbrella; embed a style/workflow correction into the governing skill, not
  just memory; **do NOT capture** environment-dependent failures or negative
  tool claims (they become self-imposed constraints that bite later); never
  edit protected/bundled skills.
- **Idle curator** (`curator.py`): inactivity-triggered (no cron) — when idle
  AND last run > `interval_hours` ago, fork an agent to pin / archive /
  consolidate. **Never deletes** (archive is recoverable).

OpenClaw cross-checks (already mapped to Muse pieces): `memory-core` dreaming
(→ N5), `skill-workshop` correction→pending-skill security-gated (→ skill
authoring + quarantine), `commitments` open-loop extraction (→ check-ins).

## 3. The seam already exists in Muse

`HookStage` (packages/agent-core/src/types.ts) already gives us everything
Hermes built by hand:

```
interface HookStage {
  beforeStart?(ctx)
  beforeTool?(ctx, toolCall)
  afterTool?(ctx, toolCall, result)   // ← count tool iterations per turn
  afterComplete?(ctx, response)       // ← post-turn review point (answer already sent)
  onError?(ctx, error)
}
```

Hooks are registered ONCE in `createMuseRuntimeAssembly` (autoconfigure) — the
runtime **CLI and server share**. So a single `HookStage` makes per-turn
learning fire on EVERY surface, fixing the CLI-only problem for free.
`createUserMemoryAutoExtractHook` already proves the pattern: it's an
`afterComplete` hook with a per-user cooldown.

## 4. Design — `createBackgroundReviewHook(...)`: one HookStage, intelligent triggers

A single new `HookStage` (in `@muse/agent-core`, wired in
`createMuseRuntimeAssembly`) that REPLACES the ad-hoc auto-extract hook and
SUBSUMES the CLI session-end distillers:

```
afterTool(ctx, toolCall, result):
   counters(userId).iters += 1            // hard tasks accrue iterations

afterComplete(ctx, response):
   c = counters(userId); c.turns += 1
   reviewMemory =  c.turns  >= memoryEvery        // turn-count trigger
   reviewSkill  =  c.iters  >= skillEveryIters     // tool-iteration trigger
   if !reviewMemory && !reviewSkill: return        // cheap turns do nothing
   // fire-and-forget, fail-soft, NEVER blocks (answer already delivered):
   void runReview({ ctx, response, reviewMemory, reviewSkill })
      .finally(reset fired counters)
```

`runReview` ORCHESTRATES the EXISTING, already-live-verified distillers under
one trigger + one conversation read — it invents no new LLM judgment, so the
NONE-aware no-fabrication guarantees (and their live batteries) carry over:

- `reviewMemory` → `createUserMemoryAutoExtractHook`'s extract (facts/prefs/
  vetoes/goals) + `inferSessionPreferences` (correction→preference, N1b) +
  `scanSessionCheckins` (open-loops→check-ins, N1a). [turn-count gated]
- `reviewSkill` → `authorSkillsFromSession` (correction→SKILL.md) +
  `distillStrategyFromCorrection` (correction→playbook). [tool-iteration gated —
  hard tasks teach]

**Counter persistence.** The server is stateless per request, so the
turn/iter counters must persist per user between turns. Reuse the
file-backed-tracker pattern (N1c's activity tracker / patterns-fired): a tiny
`review-counters.json` keyed by userId. CLI single-process can keep them in
memory; both behind one small store interface.

**Idle arm = the curator we already have.** N1c's idle-gated consolidate
daemon IS Hermes' curator arm — keep it; the engine doc just names it as the
"idle" half so the two arms (per-turn review, idle curate) are one story.

**What it deletes/replaces.** The four CLI session-end blocks (`*_ENABLED`
flags in chat-ink) collapse into the engine. Keep a single master switch
(`MUSE_BACKGROUND_REVIEW_ENABLED`, default off → exact current behaviour until
opted in) + per-channel interval knobs. Manual commands
(`muse user model infer`, `checkins scan`, `skills author`, `memory promote`)
STAY as on-demand surfaces.

## 5. Non-negotiables it must honour

- **Answer is never blocked / never altered.** Review is post-`afterComplete`,
  fire-and-forget, fail-soft (a thrown distiller is swallowed). Same as
  Hermes' "main conversation + prompt cache never touched".
- **Local-first.** All review LLM calls go through the same local-Qwen
  provider; no cloud egress (respect `MUSE_LOCAL_ONLY`).
- **No fabrication.** Reuse the existing NONE-aware distillers verbatim; the
  engine only decides WHEN to call them, not a new judgment.
- **Outbound-safety untouched.** Review may write to LOCAL stores
  (memory/skill/playbook/checkin schedule) only. It performs NO third-party
  send and schedules NO autonomous outbound — check-ins remain draft-first via
  the existing gate. Archive-never-delete for any skill mutation.
- **Security is code, not the review prompt.** The skill body risk-scan +
  quarantine (already built) still gates anything the review authors.

## 6. Incremental build plan (each slice verifiable)

1. **[DONE] Counters + engine skeleton.** `createBackgroundReviewHook` with
   `afterTool`/`afterComplete` counting + trigger logic + a counter store.
   Unit-tested; inert (no-op runReview, unwired). No behaviour change.
2. **[DONE — auto-extract] Route memory arm** (turn-count). `buildBackgroundReviewHooks`
   (autoconfigure) wires the engine behind `MUSE_BACKGROUND_REVIEW_ENABLED`
   (default off): when on, auto-extract runs on the turn-count trigger across
   EVERY surface, replacing the standalone per-turn hook. Preference-infer +
   check-in-scan still pending — they live in apps/cli and must move into a
   package before the engine (a package) can call them (slice 2b/3).
3. **[DONE — skill authoring] Route skill arm** (tool-iteration). New
   store-injected `reviewSkillsFromTurns` (@muse/agent-core) reused by the
   engine; autoconfigure builds the skill-arm callback over the turn's LIVE
   conversation (`context.input.messages`) → `AuthoredSkillStore.writeOrPatch`,
   gated by its OWN flag `MUSE_BACKGROUND_REVIEW_SKILL_ARM` (D2: careful
   rollout) on top of the engine switch. PROVEN on real qwen
   (`verify-background-review.mjs`, in the `eval:self-improving` gate): a
   procedural correction authors a reusable skill end-to-end; a no-correction
   turn authors nothing. KNOWN limit (logged, informational): a small model
   sometimes authors a narrow skill from a style-only preference — benign
   (risk-scanned + consolidate folds it). Playbook distill under the skill arm
   still pending.
4. **Retire the CLI session-end blocks** behind the master switch; one
   migration note; smoke:broad + a CLI session-end regression test.
5. **Name the idle curator arm** (doc + a thin `reviewIdle` alias to N1c) — no
   new behaviour, just unifies the two arms in one place.

## 7. Decisions for review (the forks I want your call on)

- **D1 — Default trigger intervals.** Memory every `N` turns (Hermes-ish:
  3?), skill every `M` tool-iterations (8?). Tune later, but pick sane
  defaults. *Recommendation: memory=3 turns, skill=10 iters.*
- **D2 — Server-side review depth.** On the API/daemon surface, do we run the
  FULL skill/playbook authoring (writes to `~/.muse/skills`) or only the
  memory arm at first? *Recommendation: memory arm everywhere immediately;
  skill arm behind the same switch but flagged for a careful first rollout
  since it writes the skill library unattended.*
- **D3 — Replace vs. parallel.** Do we RETIRE the four CLI session-end blocks
  (cleaner, one code path) or leave them and add the engine in parallel
  (safer, but keeps the fragmentation)? *Recommendation: retire — the whole
  point is one path; keep the manual commands as the escape hatch.*
- **D4 — Forked sub-agent vs. direct distiller calls.** Hermes forks a
  whitelisted agent. Muse's distillers are already scoped pure functions, so
  we DON'T need a forked tool-whitelisted agent — calling them directly is
  simpler and equally safe. *Recommendation: direct calls (no fork); revisit
  only if we later want the review to use tools.*

## 8. Hostile self-review (what could make this busywork or wrong)

- *"Is this just renaming the N1 hooks?"* No — it adds the two trigger models
  Muse lacks entirely (turn-count + tool-iteration "hard tasks teach"), and it
  extends skill/playbook/preference/check-in learning to the **server surface
  that currently gets none**. That's new user-facing behaviour, not a rename.
- *"Could it double-write?"* Risk: auto-extract currently runs every turn; if
  the memory arm also runs it on the turn-count trigger, the same exchange is
  extracted twice. Mitigation: the engine OWNS the per-turn cadence — auto-
  extract stops being its own hook and runs ONLY via the engine, so there's
  exactly one extraction path. (Slice 2 must delete the standalone hook, not
  add alongside it.)
- *"Server unattended skill authoring is scary."* Real. D2 gates the skill arm
  for a careful rollout; quarantine + risk-scan + execute-gating already apply;
  archive-never-delete bounds blast radius. The acceptance check must prove a
  poisoned correction quarantines, not activates.
- *"Counters drift / never fire."* The reconstruct-from-history guard Hermes
  uses (seed counter from prior turn count) avoids a cold counter never
  reaching the interval; slice 1's tests must cover restart mid-interval.
- *"Verified?"* Each slice gates on `eval:self-improving` (the N6 gate) +
  the touched distiller's live battery + a runtime integration test that a
  hard (multi-tool) task actually trips the skill trigger — not unit-only.

## 9. Out of scope (deliberately)

Reworking the distillers' own prompts; a forked tool-using review agent;
cloud memory backends; any autonomous outbound. Those are non-goals for this
engine — it is the ORCHESTRATION layer, not new judgment.
