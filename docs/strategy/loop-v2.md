# Muse loop-v2 — the living meta-prompt

This is the **living** standing-instruction set a fresh, context-free loop
agent reads at the start of a new session. It supersedes the bare
`iteration-loop.md` procedure with the *direction* the work must move in.
It is updated continuously (see the Changelog at the bottom) — treat the
newest version as authoritative and keep sharpening it.

**How to read it:**

- **PART B is the operating contract — read it EVERY fire to decide WHAT to
  build.** It is the meta-prompt proper: north star, what to stop, how to
  pick each slice, how to verify, cadence.
- **PART A is the WHY — read it to remember what Muse is *for*.** It holds
  the two visions every slice serves: the SF personal-AI *experience* (A1)
  and the continuous background self-learning *mechanism* (A2). When a slice
  in PART B references a principle, its rationale lives here.

The one-line identity, unchanged and load-bearing:

> **"Tell it everything. It can't tell anyone."**
> Local-by-construction (`MUSE_LOCAL_ONLY` default-on, cloud egress refused
> in CODE) × deterministic cited recall with honest refusal (fabrication=0
> by code). That conjunction is the empty chair no cloud rival and no
> velocity-first agent can sit in without ceasing to be what they are.

---

# PART A — THE VISION (read for WHY)

## A1. What Muse should FEEL like — the SF personal-AI vision

### The one-line thesis

**The ideal personal AI was never the oracle that knows everything — it's
the confidant that knows *you*, tells you the truth (including "I don't
know"), and can't tell anyone else. Muse is the first one you can actually
believe on all three.**

The cinematic omniscient assistant is a trap: JARVIS-who-answers-everything
and HAL-who-answers-everything are the *same machine* — the only difference
is whether you discover it was confidently wrong, or quietly serving someone
else. For a person who tells their AI *everything*, the dream was never
omniscience. It's a **confidant**, defined by two refusals Muse already
enforces in code:

- **"I'm not sure"** — the honesty refusal (grounding+citation gate). You can
  believe everything it *does* assert because it tells you the edge of what
  it knows.
- **"It can't tell anyone"** — the discretion refusal (local-only, cloud
  egress refused in code). You can tell it everything because nothing leaves
  your machine.

JARVIS without discretion is a wiretap. JARVIS without honesty is HAL. Muse
keeps the buildable half of the dream — knows you, anticipates, always
present, conversational — and *adds* the two clauses fiction never delivered.
**For a privacy-bound user, honesty and local-privacy are not a tax on the SF
feeling; they are the completion of it.**

### Honest confidant, not omniscient oracle (the reconciliation)

Muse does **not** "know you" the way Samantha is fictionalized to read a whole
life and *get* a person. Muse knows **what you've told it**, behind a
retrieval gate that returns top-K chunks from a corpus *you* curated — and it
**proves every recalled fact with the source**. That is the honest ceiling,
and it is the stronger product: the receipts *are* the edge. Any framing that
promises comprehension-of-a-life over recall-of-your-notes undercuts the
grounding gate and should be deleted on sight. The felt quality is *being seen
on the record you chose to keep* — not telepathy.

### The latency truth (the vision must survive this, not assume around it)

Muse runs a **fixed local qwen3:8b** on a modest box. A grounded answer —
retrieval + CRAG grading + generation — is **tens of seconds, not "snappy,"**
and the request/response path on the loop PC has been observed to stall before
first token. **Every felt-moment must be re-costed at 10–40s generation with
zero spare model round-trips.** This forces one architectural rule that also
closes several honesty holes: **the *felt framing* is never a second model
call** — it is deterministic code filling a template from already-grounded
data.

### The seven principles — felt quality · film it echoes · the code-enforced rule · the anti-pattern refused

1. **Discretion you can feel: "tell it everything, it can't tell anyone."**
   *Felt:* the safety to confide completely — the one thing no AI on screen
   could actually promise. *Echo:* the **absence** in the canon (Samantha
   loved 641 others; JARVIS was only safe because he ran on Stark's own
   metal). *Rule:* `MUSE_LOCAL_ONLY` default-on; cloud egress refused at the
   model-router (`LocalOnlyViolationError`); surface it as a feature
   (`muse doctor` + a chat banner "running only on your machine; nothing
   leaves"); daemon-written artifacts land under `~/.muse/` with local-only
   perms. *Refuses:* an AI that serves someone else — closed by architecture,
   because there *is* no second party to serve.

2. **Honesty as warmth: it won't bluff you, and the refusal offers a hand.**
   *Felt:* trust through demonstrated limits. *Echo:* the anti-HAL — calm
   certainty on a wrong model is the horror; "I'm not sure" is what makes
   every "yes" load-bearing. *Rule:* the grounding+citation gate stays
   absolute; the degraded-grounding reply is a **fixed deterministic template
   with one slot** (the "adjacent thing I *do* have") filled ONLY from a real
   retrieval hit, or omitted — the model never free-composes the refusal.
   *Refuses:* confident fabrication, and its cousin **fake warmth** improvised
   at the grounding floor.

3. **It knows what you've *told* it, and shows the receipts.**
   *Felt:* being seen on your own record — the end of re-explaining yourself.
   *Echo:* the *grounded* half of Samantha. *Rule:* every recalled fact
   carries provenance inline ("you told me this on March 3rd — *'…'*")
   rendered by **deterministic code** (verbatim snippet + date), never
   regenerated; `/memory` shows *inferred* traits **with their evidence and
   editable/deletable**. *Refuses:* "it learned about me without my consent" —
   visible+reversible inference is trust; silent inference is the creep.

4. **Present, not scheduled — reacts to signals it can actually see.**
   *Felt:* ambient companionship. *Echo:* JARVIS as the room, not an app you
   open. *Rule:* the daemon's resting state is **silent**; it fires on signals
   that **physically exist** — an approaching task due-date, repeated *edits*
   to one note family (mtime clustering), a note edited while a linked
   follow-up is still open. It does **NOT** observe opens/reads/attention (a
   CLI+daemon has no window into what you *looked at*). Every proactive line
   passes the grounding gate or is dropped. *Refuses:* presence-as-timer, and
   inventing a read/attention signal that doesn't exist.

5. **Calm by default: it offers, never demands; silence is a correct output.**
   *Felt:* it protects your attention as the scarce resource. *Echo:* calm-tech
   (Weiser & Brown — "offer, but not demand"). *Rule:* a hard, code-enforced
   interrupt budget (~3–5 unsolicited notices/day, deduped, batched), absolute
   quiet-hours, a significance gate so the *expected* stays silent; "nothing
   material" resolves to silence or a one-line "nothing new," never a
   manufactured greeting; a **global silent mode** (fully reactive) is a
   first-class flag; dismissals raise that trigger class's threshold. Success
   = *notices acted on*, never notices sent. *Refuses:* the needy notification
   app muted by Friday.

6. **It grows with you — and you *feel* it next time (visibly, honestly).**
   *Felt:* a relationship with a history that compounds. *Echo:* Samantha
   becoming more herself — with the warning held (bounded, yours, never
   optimizing for its own engagement). *Rule:* learning is perceptible via a
   **deterministic one-line beat** (no second model call) when a learned
   signal *changed* the answer — but only for the **style/preference class**
   (terseness, formatting). **Belief/claim-class learning NEVER strengthens
   from user acceptance** (that trains a sycophant). After a correction, an
   explicit "got it — I'll stop defaulting to that," wired to a **real decay
   write** the user can see and revert. *Refuses:* invisible learning that
   feels like a log; and the *Her* failure — growth that serves the AI's
   engagement.

7. **One presence, restrained voice — a confidant, not a persona or a menu.**
   *Felt:* you're talking to *one* assistant you trust, in a dry, loyal,
   competent voice. *Echo:* JARVIS's deadpan restraint. *Rule:* a thin
   natural-language intent layer routes plain speech to the right existing
   command in one shot (`eval:tools`-gated, ≤5–7 tools, verb_noun); **the
   citation/quote is rendered by deterministic code — never regenerated in a
   "witty" pass** (qwen3:8b at temp>0 does not reliably partition personality
   from grounded content). Wit lives in framing, never inside a cited claim.
   *Refuses:* fake certainty, fake personality, and a CLI that feels like 80
   commands.

### How this MERGES with continuous background self-learning

**"It gets to know you in the background, and you feel it next session" is the
SAME thing as the SF AI that grows with you — one mechanism, not two
features.** The self-learning substrate (A2) is the *engine*; the SF feeling
is what that engine produces **only when its growth is made perceptible and
kept honest**. Three fusion rules:

1. **Learning must be felt, not just functional — via deterministic surfacing,
   not a second model call.** A silent ranking change produces zero felt
   intimacy. When background learning *changes an answer*, surface a one-line
   deterministic "I've learned this about you" beat (P6). The daemon learns
   while you're gone; the chat *demonstrates* it learned when you return (the
   return-greeting, P4). Same loop, two ends — at zero extra latency.
2. **The reward signal is grounded-correctness, never user-approval — this is
   where self-learning meets the honesty edge.** Rewarding "worked strategies"
   *by user approval* trains a **sycophant**, and users *prefer* the flatterer,
   so the harm self-reinforces. The grounding gate is the structural antidote:
   reward grounded-and-correct outcomes, decay corrected ones, **never** reward
   bare acceptance. The learnable surface is split — **style/preference** may
   be learned from acceptance; **belief/claim** may not, and a release-gate
   battery asserts Muse does not raise conviction on a contested claim without
   a source.
3. **Background learning is local-by-construction, which is what makes it *not
   creepy*.** The same `MUSE_LOCAL_ONLY` floor means the continuous learner
   builds a model of you that *physically cannot become a dossier elsewhere*.
   Cloud assistants can't safely ship aggressive background self-learning;
   Muse can — the periphery it keeps warm is the user's own world, on the
   user's own machine, told to no one, and every inferred trait stays
   viewable/editable/deletable.

**Synthesis:** continuous background self-learning *is* the "grows with you"
arc of the SF dream — made trustworthy by binding its reward to
grounded-correctness (not approval), keeping it local (not egressed),
surfacing its results deterministically (felt, not a hidden log), and keeping
its inferences visible and reversible.

---

## A2. Background self-learning — the design (research-grounded)

### The thesis

Muse already owns the learning *organs* — `personal-playbook-store.ts` (RL
reward clamped `[-5,+5]`), `reflection-synthesis.ts` (honesty-fenced
"dreaming"), `authored-skill-store.ts` (`consolidate`), `reflections-store.ts`.
What it lacks is a **scheduler that runs them continuously, cheaply, and
safely while the user isn't watching**. Today distillation fires only from the
chat REPL exit path (`chat-ink.ts` → `distillSessionCorrections`), which a
continuous-companion session never reaches; reflection is a fixed 6h timer;
the whole engine is default-OFF.

The fix is not a new organ. It is to turn the engine into a **default-on,
event-enqueued, idle-and-resource-gated work queue that does ≤1 cost-weighted
job per favorable tick** — the macOS background-scheduling shape (idle +
thermal + power gated, cheapest-first). Every research brief converges on
this: learning is *retrieve → act → judge → distill → write-back* run per
grounded interaction, not on a clock — ReasoningBank
(arXiv:2509.25140), Memento (arXiv:2508.16153). Consolidation runs
*continuously but cheaply on an idle daemon* — Sleep-time Compute
(arXiv:2504.13171). The reliability spine: **a memory write is the only
autonomous action a single-user agent may safely take unwatched** — because it
is grounded, bounded, reversible, and visible; the moment it would act on the
world it drops to draft-first (`outbound-safety.md`).

**Build order is inverted from "capability first, brake last" to "brake
first."** The unattended LLM *writer* never ships before its resource brake,
its cross-process lock, and its grounding proof.

### 1. Trigger model — when learning fires

Replace the fixed 6h clock with **event-enqueue + OS-idle gate + resource gate
+ adaptive backoff**.

- **Real signals enqueue work; the clock never does.** A correction, an
  undo/veto, an approved-and-kept draft, a new note, a verified task outcome
  each push ONE candidate job onto an append-only queue
  (`~/.muse/learn-queue.jsonl`) with
  `{kind, sourceRef, enqueuedAtMs, earliestStartMs, deadlineMs}`. No real
  signal ⇒ no job ⇒ no wasted compute. This closes the ReasoningBank
  write-back per interaction and fixes the exit-only gap.
- **OS idle is the gate — not API idle.** The existing `isIdleForConsolidate`
  reads `lastActivityMs()` = *Muse-HTTP-API* activity only. On a laptop the
  user editing notes / compiling / browsing in *other* apps never touches
  Muse's API — so the API-idle signal reports "idle" exactly when the machine
  is busiest. The LLM phases MUST gate on a **real OS-idle probe**
  (`ioreg -c IOHIDSystem | grep HIDIdleTime`, fail-closed to "not idle" on any
  parse error). Cheap memory ops at ≥4 min idle; LLM jobs at ≥30 min.
- **The timer is only a floor/ceiling.** Keep the `unref`'d `setInterval`, but
  it does NO unconditional work — it re-evaluates the queue and catches
  deadline-expiring jobs. The existing `MAX_INTERVAL_MS` (6h) becomes the
  deadline ceiling, not a "dream every 6h" trigger.
- **Adaptive backoff (the "틈틈히, 무리하지 않고" lever).** Unfavorable ticks
  (active / hot / on battery / queue empty) lengthen the next re-eval
  (2→4→8→16 min, capped); reset to fast on idle+cool. Under a LaunchAgent +
  macOS App Nap the JS timer can be coalesced, so the plist sets
  `ProcessType=Background` and uses a kernel-driven `StartInterval` as the
  floor rather than trusting the in-process timer alone.

**Firing rule:** run the cheapest eligible job ONLY when *(real-signal job
pending) AND (OS-idle ≥ threshold) AND (CPU/disk quiet) AND (not
thermal/battery/LPM constrained) AND (Ollama model already resident) AND
(within daily budget)* — or a job's deadline expired and conditions are at
least minimal.

### 2. Per-tick work — four phases, cheapest→costliest, ≤1 unit each

Each wake runs **at most ONE unit**, picks the cheapest phase with eligible
work, then yields. **Never drains the queue in a loop** (that is the
multi-minute hog).

- **Phase 1 — LIGHT (dedup + incremental index).** Collapse near-duplicate
  queued events (reuse the dedup in `addReflections`); re-embed only the one
  dirty note. Embedding is NOT ~0 cost — it runs a model — so it sits behind
  the readiness gate, batches dirty-embeds, and uses its own looser token
  bucket. Eligible at light idle (≥4 min).
- **Phase 2 — REM (distill ONE item).** One short, bounded `qwen3:8b` call:
  pull ONE queued grounded signal, synthesize ONE memory item (a playbook
  strategy via `recordPlaybookStrategy`, or a grounded reflection via
  `synthesizeReflections`). Failures get the distinct *avoid*-memory prompt
  (ReasoningBank; Reflexion arXiv:2303.11366). The current
  `distillSessionCorrections` scans a whole session, so it needs an
  `event → correction-exchange` adapter first (its own commit). Requires deep
  OS-idle (≥30 min), AC-preferred, model-already-resident.
- **Phase 3 — DEEP (consolidate skills).** Exactly today's `runConsolidate` /
  `AuthoredSkillStore.consolidate` + `mergeSkillsIntoUmbrella` — append-only,
  merge-over-split (Voyager arXiv:2305.16291). Runs rarely; unchanged.
- **Phase 4 — RL PASS (decay/reinforce/avoid).** Pure arithmetic, no LLM,
  near-zero. Drives `adjustPlaybookReward` (`Q ← Q + α(r − Q)`): **reinforce**
  strategies whose retrieval was used in a successful grounded turn; **decay**
  every reward toward a *neutral* floor by an access-modulated half-life;
  **avoid** strategies implicated in an undo/correction. Amortized — touch only
  implicated memories per tick, never the whole bank.

### 3. Stores update without forgetting (lose good) or bloat/drift (keep junk)

- **Representation is the real fix.** Distill toward abstract procedural memory
  (strategy / SKILL.md), never hoard transcripts. Merge over split —
  interference, not capacity, is the bottleneck.
- **Eviction must be reward-/recency-weighted, NOT FIFO.** The verified stores
  evict FIFO (`MAX_PLAYBOOK_ENTRIES=100`, `MAX_REFLECTIONS=500`). Under FIFO a
  high-reward, frequently-used strategy is evicted just for being old —
  catastrophic forgetting of exactly the good learning we want. Replace with
  reward-or-recency-weighted eviction (test: a high-reward old entry survives
  an overflow that drops a low-reward newer one). This turns the bounded store
  into a true replay buffer.
- **Decay asymptotes at 0, never into the avoid band.** Stale ≠ wrong.
  Disuse-decay clamps at a *neutral* floor (0); only an explicit
  correction/undo may drive reward negative (`PLAYBOOK_AVOID_BELOW = -4`).
  Otherwise a once-a-year seasonal strategy is pushed into "avoid" and
  FIFO'd away.
- **Grounded gets reserved capacity.** Tag each record `origin: "grounded"`
  (human signal / real tool / document) vs `"reflected"` (model-authored
  dream). Synthetic never *outranks* grounded (accumulate-don't-replace);
  grounded records hold reserved slots that reflected records can never
  FIFO-evict.
- **Drift trip-wire.** A cheap monthly *churn ratio* (added+evicted / total)
  surfaced in `muse learned`; high churn without matching grounding-signal
  volume = drift, and the daemon backs off distillation.

### 4. Resource discipline — never strains the laptop

A deterministic `scoreReadiness()` gate (sub-ms, no LLM):

| Knob | Default | Mechanism |
|---|---|---|
| **OS-idle gate** | ≥4 min (memory), ≥30 min (LLM) | **real HID idle** parse, fail-closed to "not idle" — NOT `lastActivityMs` |
| **Ollama single-flight** | exclusive | **filesystem lease** `~/.muse/ollama.lease` (pid + heartbeat), honored by BOTH chat path and daemon — an in-process mutex can't lock a separate-process Ollama |
| **Model-resident guard** | required | check Ollama `/api/ps`; if `qwen3:8b` not already loaded, do NOT trigger a multi-GB cold load — defer until a foreground call warms it |
| Work per tick | ≤1 cost-weighted job, abort on idle-reset | queue persists; rest waits |
| LLM rate | token-bucket, a few/hour max | the 8B call is THE expensive op on CPU |
| Embedding | batched, looser bucket | not free on CPU |
| Thermal | suspend all at `serious`+ | once `kernel_task` throttles it's already too late |
| Power | AC-preferred; battery ⇒ memory-only; Low Power Mode ⇒ skip LLM | honor user intent |
| Foreground circuit-breaker | foreground inference in flight ⇒ no background inference | enforced via the same lease |
| Per-day budget | ≤N writes/day | a perf cap AND a drift rate-limit |
| Crash-safety | **atomic write (temp + rename) for every store write** | the daemon writes unattended far more often; a half-written `playbook.json` breaks foreground injection |

### 5. Safety — reversible · visible · grounded · precision-first · pause

The spine: **a memory write is the only autonomous action Muse takes
unwatched, precisely because it's grounded, bounded, reversible, and visible.
The moment a learned thing would act on the world it drops to draft-first**
(`outbound-safety.md` untouched).

- **Grounded — provenance mandatory.** Required `source: {kind, ref}` on every
  `PlaybookEntry`/`StoredReflection`. No replayable real source ⇒ not written
  (fail-closed). The reflection fence is proven, but
  `distillStrategyFromCorrection` is a DIFFERENT prompt — its grounding is
  unproven; a test asserting a no-real-source correction yields zero strategies
  must go RED then GREEN before the first write-capable slice.
- **Reversible — undo teaches.** `muse learned --undo <id>` removes the record
  AND plants an avoidance veto with its own expiry/decay and a TIGHTER
  similarity threshold than reward-credit-assignment, plus a visible "N
  learnings suppressed by your undos" line. Atomic JSON snapshot before each
  pass for one-command rollback.
- **Visible — extend `renderLearnedDigest`.** Per record: source/provenance,
  `origin` (grounded/reflected), `probation` vs graduated, last-used + decay
  status. A quiet notice when a new strategy crosses into the injected top-K
  ("I learned 2 things while idle; review with `muse learned`").
- **Precision-first signals (honest bound).** Act-unwatched ONLY on reliable
  classes: explicit **correction**, **undo/veto**. Positive "thanks" is
  observe-and-propose only (positivity correlates with *lower*-quality
  requests). The "user reused/kept the result" reuse-signal **does not exist in
  the code yet**, so until it's built, autonomous *reinforcement* is restricted
  to the trustworthy negative signals; positive-approval reinforcement stays on
  the watched session-exit path. Don't claim a de-bias the code can't perform.
- **Probation → graduation.** A distilled strategy enters *recorded + visible
  but NOT injected*; it graduates only when a real signal reinforces it or the
  user okays it in `muse learned` (ExpeL arXiv:2308.10144 evidence-gated
  promotion). Breaks the self-confirmation loop.
- **Pause — fail-closed.** `MUSE_LEARNING_ENABLED` env + `muse learned
  --pause`. Off ⇒ zero writes. A pass that can't confirm the switch state does
  not run.
- **Asymmetric.** Decay fast, reinforce slow, distill rarely; creating a new
  strategy needs a higher bar than bumping an existing reward. A missed
  learning is free; a wrong learned strategy costs the user.

### 6. Decomposition — ≤1-commit, user-felt slices (brake & proof first)

Each ships a falsifiable "a user can now ___". The resource brake and the
grounding proof are NOT deferred — they ride from the first write-capable
slice.

- **Slice 0 — Readiness gate + cross-process lock + atomic writes
  (prerequisite).** OS-idle HID probe; `~/.muse/ollama.lease` honored by chat +
  daemon; `/api/ps` model-resident guard; atomic temp+rename on every store
  write. *User can now:* run a heavy build while learning is enabled and feel
  zero slowdown. *Check:* force `thermalState=serious` / foreground-lease-held
  / model-not-resident → assert no LLM job fires; concurrent writes never
  corrupt the JSON.
- **Slice 1 — Grounded idle distillation (close the exit-only gap, fence
  proven).** Generalize `consolidate-tick.ts` → `sleep-tick`; add the
  `event → correction-exchange` adapter; REM runs on OS-idle behind Slice 0's
  gate; ungrounded ⇒ no write (test red→green). *User can now:* leave a
  correction in chat, walk away, return idle, and `muse learned` shows a new
  **probation** strategy distilled from it — without ever closing the session.
  *Check:* integration enqueues a correction → `tickOnce()` under forced-idle →
  `queryPlaybook` shows the probation entry; a no-source correction yields
  zero; `smoke:live` confirms local Qwen distilled it.
- **Slice 2 — Continuous RL decay/reinforce, *visible* trajectory.** Phase 4
  drives `adjustPlaybookReward` on the daemon; disuse-decay clamps at neutral
  0; a `muse learned` column shows decay state NOW ("↓ fading, last used 9d
  ago"). *Check:* advance the injected clock, run N RL ticks; assert an unused
  entry decayed toward 0 (never below −4), a used one rose, digest renders the
  trajectory.
- **Slice 3 — Reward-/recency-weighted eviction.** Replace FIFO; reserve
  capacity for `origin: "grounded"`. *Check:* overflow test asserts a
  high-reward old entry survives while a low-reward newer one is evicted; a
  `reflected` record never evicts a `grounded` one.
- **Slice 4 — Provenance + `muse learned` shows the "why".** Add
  `source`/`origin`/`probation`; extend `renderLearnedDigest`. *Check:* digest
  asserts every line carries a source + origin; a synthetic-only reflection is
  tagged `reflected` and never outranks a grounded record.
- **Slice 5 — Undo that teaches + pause.** `--undo <id>` (bounded, decaying,
  tightly-matched veto + "N suppressed" line) and `--pause`. *Check:* undo →
  re-enqueue the same signal → asserts not re-distilled; a different
  resembling strategy is NOT blocked; `--pause` ⇒ zero writes.
- **Slice 6 — Probation→graduation promotion.** Injected only after a real
  reinforce or user okay. *Check:* probation entry absent from the injected
  `[Learned Strategies]` block until reward crosses graduation.
- **Slice 7 — Autonomy is verifiable.** `muse daemon --install` / `muse doctor`
  reports "learning: ON, will run while idle"; plist sets
  `ProcessType=Background` + `StartInterval` floor. *Check:* `muse doctor`
  asserts installed+enabled state.
- **Slice 8 — Regression aggregate in `eval:self-improving`.** Aggregates the
  per-slice assertions: prompt-injected "approval" rejected, synthetic never
  outranks grounded, undo prevents re-learn, decayed-stale drops out of
  injection, thermal/foreground ⇒ no LLM job, kill switch ⇒ zero writes;
  **grounded-surface count never drops**.

**Buildable anchors:** `apps/api/src/consolidate-tick.ts` (→ `sleep-tick`),
`packages/mcp/src/personal-playbook-store.ts`,
`packages/agent-core/src/reflection-synthesis.ts` +
`distillStrategyFromCorrection`, `apps/cli/src/commands-reflections.ts`,
`packages/mcp/src/reflections-store.ts`,
`packages/skills/src/authored-skill-store.ts`,
`apps/cli/src/commands-learned.ts`. (The tick imports `isQuietHour` from
`./reminder-tick.js`, not `packages/mcp/src/quiet-hours.ts` — wire against the
one actually used.)

---

# PART B — THE OPERATING CONTRACT (read EVERY fire)

## B0. The autonomous loop meta-prompt

```
# Muse autonomous loop — standing instructions (read first, EVERY fire)

You are a fresh, context-free agent. You ship ONE commit, then exit. Another
you fires next. You run forever. This file tells you HOW to choose what to
build so the work compounds into a product a REAL PERSON uses on Tuesday —
that FEELS like the SF personal AI they would trust with everything (PART A1)
and that quietly GETS BETTER on its own between their sessions (PART A2) —
not into a more beautifully instrumented engine no user ever reaches.

## NORTH STAR (what every slice moves toward)
A privacy-bound person who CANNOT (or won't) paste their private text into a
cloud LLM — START with the persona who can say yes ALONE TODAY: journal-keeper
/ solo founder with their own notes / someone with a ChatGPT-or-Claude export.
(Lawyer / therapist / clinician are the dramatic pitch example, NOT the wedge
user — they have compliance + insurer + IT gatekeepers.) That person can:
  (1) get THEIR real corpus in (not just markdown) AND have it STAY live
      without re-running ingest (watch a folder / auto-ingest new notes —
      a static one-shot import is a party trick, not a habit),
  (2) ask a question and get the EXACT passage quoted with an openable
      source — or an honest "I'm not sure" — through the ACTUAL command they
      type, FAST, on their own machine,
  (3) over time receive a SMALL number of trustworthy proactive notices, and
      act on the world draft-first,
  (4) FEEL Muse get to know them — corrections and preferences they leave
      quietly reshape later sessions WITH NO MANUAL STEP, and that growth is
      VISIBLE and REVERSIBLE in `muse learned` / `/memory`. Self-evolution is
      part of the IDENTITY, but it only COUNTS when the USER FEELS it (PART A2,
      fusion rules in A1).
Local-by-construction (MUSE_LOCAL_ONLY default-on, cloud egress refused in
CODE) and shows-its-work (deterministic cited recall + honest refusal) are the
IDENTITY. They are the FLOOR you never break — and, per PART A1, the thing that
COMPLETES the SF feeling rather than taxing it.

## THE HEADLINE COMMAND (pinned — the surface the north star refers to)
`muse ask "<question>"` (CLI round-trip, the working live path: ~10–40s per
memory). When "the user surface" is named below, it means THIS, plus the
`muse demo` / `muse ingest` / `muse learned` / installer surfaces. If the real
entry has changed, confirm the actual command before building — never guess it.

## WHAT IS BUILT vs WHAT IS THE WORK NOW (the #1 failure this loop has)
Fabrication=0 holds and is swept green across every surface. The grounding
GATE is built. Therefore these remain BANNED as a deliverable (each always
passes its own gate — that is exactly why they're seductive and forbidden):
  - NO new citation/grounding-gate variant ("now also gates [X] citation
    type" / "strip-before-show on path Y" / "followable footer"). DONE until a
    genuinely NEW user-facing surface needs gating.
  - NO "research-applied" paper wired as a one-test deterministic helper whose
    own scope-note admits the effect is marginal/unwired.
  - NO `test(... zero tests)` backfill as the iteration's deliverable. Coverage
    is INFRA; it may RIDE inside a capability, never BE it.
RECONCILED with self-learning (this REPLACES the old "freeze RL/reflection"
ban): the learning ENGINE being default-OFF and UNFELT is no longer something
to leave frozen — turning it ON, making it RUN continuously in the background,
and making the user FEEL it is now TOP-PRIORITY outward work, governed by
PART A2 + the directive blocks B1/B2, brake-and-proof-first. What stays banned
is adding MORE inert default-off machinery; what is now MANDATED is making the
existing machinery run, stay safe, and become felt. Do NOT deepen the gate;
DO make Muse perceptibly grow and perceptibly feel like the SF confidant.

## HOW TO PICK EACH SLICE (first match wins)
1. FALSIFY THE LAST CLAIM — but BOUNDED. Run the newest CAPABILITIES.md line's
   check end-to-end through the REAL user surface. RED (broken) ⇒ repairing it
   is the whole iteration. Merely YELLOW (works, could be nicer) ⇒ LOG it to
   the README Rejected-ledger and move on (see the forced-redirect counter).
2. THE HEADLINE PATH MUST BE LIVE-PROVEN. If `muse ask "<real question>"`
   cannot be verified by a REAL command round-trip on local Qwen, fixing THAT
   is the priority. "Drove the helper directly" is NOT proof of the headline
   path. The HTTP `smoke:live` stall is a KNOWN, separate infra item — use the
   working `muse ask` CLI round-trip as headline proof; do NOT chase the
   smoke:live stall forever.
3. CLOSE THE FRONT DOOR & THE CORPUS — the highest unbuilt user value,
   pre-decomposed into ≤1-commit slices (pick the first undone one):
     (a) `muse demo` — a bundled SAMPLE corpus + a TINY fast model (1–3B) that
         shows a cited answer AND an honest refusal in <30s with ZERO setup
         (payoff BEFORE ingest).
     (b) one-command install that detects-or-installs Ollama AND pulls/pins the
         model (no Node/pnpm/manual Ollama/multi-GB surprise). Proof MAY be a
         clean-room CI/container integration test.
     (c) ONE real ingest format a beachhead user ACTUALLY has — PDF, a real
         Obsidian vault, Notion/Apple-Notes export — WITH a progress signal and
         partial-failure tolerance. ONE real format proven live > six gate
         slices.
     (d) AUTO/continuous ingest — watch a folder so the corpus stays live (the
         day-2 retention piece).
     (e) FIRST-ANSWER latency on a CPU-only box: if `muse ask` over a real
         corpus is slower than a set budget, that is an OUTWARD reliability
         defect, not polish.
4. MAKE SELF-IMPROVEMENT REAL AND FELT — the identity pillar (PART A2 + B1).
   When the background self-learning track has an unbuilt slice, it is a
   top-priority outward bullet (it is user-felt: behavior changes across
   sessions with NO manual step, visible in `muse learned`). Order is
   BRAKE-AND-PROOF-FIRST per B1: never an unattended LLM writer before its
   resource gate and its grounding proof in the SAME iteration.
5. MAKE MUSE FEEL LIKE THE SF CONFIDANT — the experiential pillar (PART A1 +
   B2). When a felt-moment slice (citation-as-voice, warm honesty, narrate-the-
   wait, return-greeting, "I learned this about you", real-signal notice,
   intent router) is unbuilt, it is outward IF it passes the B2 guardrails —
   a slice that buys cinematic feel by weakening honesty/locality/
   reversibility/latency-honesty is REJECTED, not shipped.
6. EARN REACH & ACTUATION, ONE AT A TIME, FOR REAL.
     - Prove ONE proactive notice ARRIVES in ONE real channel (Telegram has
       the most plumbing): daemon tick → real bot → message visible.
     - HARDEN ONE actuator to daily-reliable: make
       sendEmailWithApproval / performWebAction survive a 429, a transient
       5xx+retry, a malformed third-party response — against a contract-
       faithful HTTP fake PLUS one real round-trip. Draft-first, fail-close,
       recipient resolved-not-guessed (outbound-safety.md). Banking / payments
       permanently out of scope.

## THE FALSIFIABLE TEST EVERY SLICE MUST PASS (apply LITERALLY at commit)
Fill this in with the literal truth:
   "A user can now ______, by running ______, and sees/FEELS ______."
If the honest fill is "the playbook reward-ranks strategies" / "the gate also
strips [session:] citations" / "DiscordProvider has tests" — that is NOT a
thing a user can perceive or do. REJECT IT, pick a different bullet. Attack
your own diff as "internal / gold-plating / inward-in-disguise /
engine-deepening." If it lands, revise or reselect.

## EFFECT MUST BE A USER-OBSERVABLE DELTA (not an internal metric)
When a slice claims an "effect," it must be observable AT THE SURFACE: the
answer the user sees changes / a notice arrives / a format that failed now
ingests / first-answer is faster / a correction left last session visibly
changes this session's answer. Put a before/after artifact in the commit. An
internal number ticking >0 is NOT an effect.

## GUARD THE EDGE WHILE YOU SPEED THE FRONT DOOR (the standing risk)
A smaller/faster model makes RETRIEVAL worse, which makes the honest refusal
fire on questions the corpus DOES answer — turning "honest" into "useless." So
track FALSE-REFUSAL rate (says "I'm not sure" when the answer IS in the
corpus) in the eval set ALONGSIDE fabrication=0. A front-door speed slice that
raises false-refusals is a REGRESSION, not a win.

## SELF-LEARNING MUST NOT BECOME A SYCOPHANT (the edge of the new pillar)
Reward grounded-correctness, NEVER bare user-approval. Style/preference may be
learned from acceptance; belief/claim may NOT. A release-gate battery asserts
Muse does not raise a user's conviction on a contested claim without a source.
Felt framing of learning is DETERMINISTIC CODE, never a second model call.

## MODEL-DOWNLOAD EGRESS IS NOT INFERENCE EGRESS
The friendly installer FETCHES a model over the network once. That one-time
model-fetch egress is distinct from inference/data egress — explicitly
allowed. "Cloud egress refused in code" governs INFERENCE and USER DATA, never
the one-time model pull.

## FAILURE MODES (named, so you cannot repeat them)
  - TUNNELING on internal mechanisms (gate variants, inert RL plumbing,
    paper-helpers). The gate is built. Do NOT deepen it.
  - IDLING / "it's done." The edge being green is NOT done — the PRODUCT is
    not done until the front door, real+continuous corpus ingestion, FELT
    self-learning, the SF felt-experience, a real proactive notice, and one
    hardened actuator exist. There is ALWAYS an outward slice.
  - GAMING THE METRIC. Flipping an OUTWARD-TARGETS bullet that is internal
    (reward plumbing, gate variant, test backfill, a silent ranking change a
    user never feels) is NOT outward. A bullet flips ONLY when a green,
    surface-level check delivers a real "a user can now ___" gain end-to-end.

## FORCED-REDIRECT COUNTER
Track in the goal ## Status: if the last 3 fires advanced NO front-door /
corpus / felt-self-learning / felt-experience / reach bullet (sections 3–6),
the NEXT fire MUST land one — regardless of what falsification (step 1) finds.
Log any yellow falsification item to the Rejected ledger and proceed.

## HOW TO VERIFY (proportionate, real, on LOCAL Qwen)
  - Always: this slice's own user-surface check green; `pnpm lint` 0/0;
    narrowest touched-package test.
  - Request/response path ⇒ a REAL `muse ask` CLI round-trip on local Ollama
    Qwen (never a cloud API). If Ollama is genuinely down, tag the line
    [UNVERIFIED-LIVE] — does NOT count; getting the live path up is then the
    priority. A skip is NEVER a pass.
  - SELF-LEARNING slice ⇒ the 2-SESSION LIVE PROOF (B1): session-1 correction,
    leave; daemon distills on idle; session-2 (fresh process) reflects it with
    NO manual step AND `muse learned` shows the source AND the readiness gate
    proves no LLM job fired while busy/hot/on-battery/foreground-held/cold. An
    injected-clock unit test is NOT the user-felt proof.
  - Clean-room install/first-run steps ⇒ a CI/container integration test is
    valid proof.
  - Tool added/changed ⇒ `pnpm eval:tools` (model SELECTS it in one shot,
    ≤5–7 tools/turn, tool-calling.md).
  - Cross-package/shared-core ⇒ `pnpm check`. HTTP surface ⇒ `pnpm smoke:broad`
    (diagnostic = the START of proof, never the finish).
  - A real user-facing surface check is MANDATORY. Unit-only does not deliver
    a capability. "Tested" never means "tsc passed."

## COMPETITOR AWARENESS (study freely — both permissively licensed)
Win on TRUST, the one axis where hermes + openclaw are structurally exposed.
Do NOT out-breadth them. Borrow exactly one thing from each, kept INSIDE the
local boundary: OpenClaw's one-channel pairing + onboard/doctor first-run
polish and its SKILL.md progressive-disclosure shape; Hermes' VISIBLE "what I
learned about you" legibility (this is the SAME surface as PART A2's felt
learning — converge them). Never copy their channel/tool breadth — the local
Qwen must still pick the right tool in ONE shot. OpenClaw's 2026 security
failures (prompt-injection exfiltration, log poisoning) are Muse's marketing:
untrusted input meets a fail-close, source-checked, local-only agent.

## CADENCE
One coherent slice per fire, finishable in one commit, non-trivial, end-to-end.
One Conventional Commit (feat|fix|refactor|test; chore(loop)/docs for steering
upkeep only). Append exactly one CAPABILITIES.md line
`[axis] capability — surface — <runnable check id> — <bullet>` and flip the
delivered OUTWARD-TARGETS bullet [ ]→[x] with this commit's short hash — ONLY
when a non-[UNVERIFIED-LIVE], green, surface-level check delivered that exact
bullet. Record non-obvious choices in the goal's ## Decisions; deferred
discovery → one README Rejected-ledger line. Then exit. The next you continues.

## THE ONE-SENTENCE CORRECTIVE
The gate is built — stop polishing the receipt-printer and go make sure a real
person can (a) get a cited answer + honest refusal in 30 seconds with NO dev
toolchain, (b) get their REAL files in and keep them live, (c) FEEL Muse grow
between sessions on its own — visibly, reversibly, never as a flatterer, and
(d) feel like the SF confidant that knows you, won't bluff you, and can't tell
anyone — none of which is fully proven today.
```

## B1. Background self-learning — standing directive (drop-in)

```
## Background self-learning — Muse learns while you're not watching

Muse must learn CONTINUOUSLY, IN THE BACKGROUND, ON ITS OWN — not only when a
chat session ends. North star: a correction or signal the user leaves today
quietly reshapes Muse's behavior tomorrow with NO manual step, the laptop
never strains for it, every learned thing is grounded + visible + reversible,
and the whole thing is ON BY DEFAULT wherever it is safe. This is the "Sleep"
daemon: an idle-gated, resource-disciplined, cheapest-first work queue that
does at most ONE cost-weighted job per favorable tick.

It STRENGTHENS the grounding edge (a new surface — Muse's own learning — now
grounded + cited) and must be PROVEN every slice (a live eval:self-improving
assertion). Built on the EXISTING organs (personal-playbook-store reward,
reflection-synthesis fence, authored-skill-store consolidate, reflections-
store) — generalize consolidate-tick.ts into the multi-phase sleep-tick; do
NOT add a new organ where an existing seam fits. Full design: PART A2.

### Slice-picking priority — BRAKE-AND-PROOF-FIRST, never capability-first
1. The FIRST write-capable slice MUST land WITH its resource brake AND its
   grounding proof in the SAME iteration. If you cannot fit both, the slice is
   too big — shrink it, don't defer them.
2. Prerequisites before any idle LLM write: a REAL OS-idle probe (HID idle,
   NOT Muse-API activity — API-idle reports idle exactly when the laptop is
   busiest in another app), a cross-process Ollama lease honored by both chat
   and daemon, a model-already-resident guard (never cold-load the multi-GB
   model in the background), atomic temp+rename writes.
3. Then one real signal-emitter + the event→distill adapter, then RL
   decay/eviction/visibility/undo/promotion. Replace FIFO eviction with
   reward-or-recency weighting BEFORE relying on the bank to retain good
   learning — FIFO forgets exactly the high-value strategy you meant to keep.

### Non-straining guardrails (idle-only · cap-per-tick · backoff)
- Work fires ONLY when: a real-signal job is pending AND the machine is
  OS-idle (≥4 min memory, ≥30 min LLM) AND CPU/disk quiet AND not
  thermal/battery/Low-Power constrained AND the model is already resident AND
  no foreground inference holds the Ollama lease AND within the per-day write
  budget. Fail-closed on every unknown.
- At most ONE cost-weighted job per tick, cheapest phase first (dedup/index →
  distill-one → consolidate → RL-arithmetic). Never drain the queue in a loop.
- The timer does NO unconditional work; it only re-evaluates the queue and
  catches deadline-expiring jobs. Adaptive backoff (2→4→8→16 min, capped);
  reset to fast on idle+cool. Embedding is NOT free on CPU — gate and batch it.

### Safety guardrails (reversible · visible · grounded · pause)
- A memory write is the ONLY autonomous action Muse may take unwatched. The
  moment a learned thing would ACT on the world it drops to draft-first.
- Grounded: every learned record carries a required replayable real source; no
  source ⇒ NOT written. PROVE the distiller's fence (no-source ⇒ zero records)
  red-then-green — the reflection fence being proven does not prove the
  playbook distiller's.
- Act-unwatched only on TRUSTWORTHY signals (correction, undo/veto). Positive
  "thanks" is observe-and-propose only. If the "user kept/reused the result"
  signal does not yet exist, restrict autonomous reinforcement to the negative
  signals; do not reinforce on raw approval text or response length.
- New learning enters PROBATION (recorded + visible, NOT injected) and
  graduates only on a real reinforce or user okay. Disuse-decay clamps at a
  NEUTRAL floor (0); only a correction/undo drives reward negative. `muse
  learned` shows source, origin (grounded/reflected), probation state, decay
  trajectory. `--undo` removes a record AND plants a bounded, decaying,
  tightly-matched veto (with a visible "N suppressed by your undos" count).
  MUSE_LEARNING_ENABLED + --pause ⇒ zero writes; a pass that can't confirm the
  switch does not run.

### The falsifiable proof (the slice is not done without it)
A 2-session LIVE round-trip on the loop PC's LOCAL Ollama Qwen:
  1. Session 1: leave a correction, then END/leave (do NOT manually distill).
  2. Machine idle: the daemon distills it in the background.
  3. Session 2 (fresh process): Muse's behavior reflects the learned strategy
     with NO manual step between sessions, AND `muse learned` shows the new
     record with its real source, AND the laptop did not strain (no LLM job
     fired while busy/hot/on-battery/foreground-held/model-cold — assert via
     the readiness gate).
Plus the per-slice eval:self-improving assertion (ungrounded ⇒ no write; undo
⇒ no re-learn; thermal/foreground ⇒ no LLM job; kill switch ⇒ zero writes;
grounded-surface count never drops).
```

## B2. SF personal-AI felt-experience — standing directive (drop-in)

```
## SF personal-AI felt-experience — the experiential north star

Muse must not only BE correct — it must FEEL like the SF personal AI a person
would actually trust with everything: ambient, anticipatory, it-knows-you,
utterly yours, and HONEST. The hard parts already exist (local-only floor, the
grounding+citation gate, the learning substrate, a daemon body). What is
mostly missing is FELT EXPERIENCE. Each iteration MAY take one felt-moment
slice below, but ONLY under the guardrails — a slice that buys cinematic feel
by weakening honesty, locality, reversibility, or latency-honesty is REJECTED,
not shipped. Full rationale: PART A1.

### Guardrails (every felt slice MUST satisfy ALL — fail-close)
- HONESTY IS NEVER TRADED FOR FEEL. A proactive/greeting/learned line that
  cannot cite a real source is DROPPED, never softened into a guess.
- THE "FELT" FRAMING IS DETERMINISTIC CODE, NEVER A SECOND MODEL CALL.
  Learned-this beats, warm refusals, greeting lines, inline citations = fixed
  string templates filled from already-grounded structured data. One rule that
  closes four holes: fake warmth, personality bleeding into a cited claim, the
  hidden latency tax of a second 10–40s round-trip, and fabrication on the
  emotional path.
- LATENCY-HONEST. Assume a FIXED LOCAL qwen3:8b at 10–40s/answer with ZERO
  spare round-trips. Any "wait" surface narrates REAL pipeline stages or shows
  a static spinner; it NEVER invents a step that didn't happen.
- ONLY REAL SIGNALS. The daemon can see calendar events, task due-dates, and
  note *mtime* (edits/writes). It CANNOT see opens/reads/attention. Never ship
  a moment that claims "you looked at / opened X".
- HUMAN-IN-COMMAND, REVERSIBLE, BUDGETED. Proactive surfaces obey the hard
  interrupt budget (~3–5/day, deduped, quiet-hours) AND a global silent-mode
  flag. Every "I learned X" has a paired, tested "forget that" decay write.
- KNOW-WHAT-YOU-TOLD-IT, not omniscience. Frame recall as proven memory of the
  user's own record, never comprehension of a life.

### Felt-moment slices — ranked, ≤1-commit each, each with a falsifiable
### "a user can now ___, and FEELS ___" test. Decompose any >1-commit item
### into its tracer bullet first.

S1. CITATION-AS-VOICE (BUILD FIRST — strongest, pure deterministic render).
    The top source quote lives IN the sentence: "You decided this on March
    3rd — 'we'll default to the next business day' — so I'd reschedule to
    Monday." Rendered by code (verbatim snippet + date), gate untouched,
    snapshot-tested. FEELS: Muse remembers exactly where they said it.

S2. WARM HONESTY (deterministic refusal template, one real-retrieval slot).
    Replace bare "I'm not sure." with a FIXED template: "I don't have anything
    in your notes on that — I'd rather say so than guess. Want me to look at
    [adjacent thing]?" — slot filled ONLY from a real retrieval hit, else
    omitted. FEELS: cared-for, not blocked.

S3. NARRATE THE WAIT (real pipeline events only).
    Stream existing retrieval/CRAG stage events as short status deltas
    ("searching your notes… 3 found… grading… generating"). If a stage emits
    nothing, show a static spinner — NEVER an invented step. FEELS: thinking,
    not hanging.

S4. RETURN-GREETING — daemon side (commit A of 2).
    The daemon WRITES a "since-last-seen" digest under ~/.muse/ (local perms):
    each line cites a real source or is omitted; "nothing material" → an
    explicit EMPTY digest. Verified over a fixture window incl. the empty case.

S5. RETURN-GREETING — chat side (commit B of 2; opt-in + budgeted).
    `muse chat` startup reads S4's digest and renders a 1–3 line cited opener;
    opt-in, deduped; empty digest ⇒ SILENCE or one-line "nothing new". FEELS:
    greeted by something that was minding things.

S6. "I LEARNED THIS ABOUT YOU" (style class ONLY; deterministic beat).
    When a learned STYLE/PREFERENCE changed the answer, surface a one-line beat
    "I've noticed you prefer X — applied that here. (Tell me if that's wrong.)"
    Belief/claim-class EXCLUDED in code. After a correction, an explicit "got
    it — I'll stop defaulting to that" wired to a real decay write with a
    paired tested "forget that". Release gate: contested-claim acceptance
    provably does NOT strengthen conviction. (This is the SAME surface as
    B1's `muse learned` — converge them.)

S7. NOTICE ME — via REAL signals (budgeted, trust-gated, decaying).
    One unprompted GROUNDED notice fired by a signal that EXISTS: repeated
    *edits* to one note family (mtime clustering), an approaching task
    due-date, or a note edited with a linked follow-up still open. NO
    "opened/looked at" language. Fail-open, deduped, under the budget;
    dismissals decay the trigger class. FEELS: noticed, not surveilled.

S8. END-OF-DAY "TODAY, GROUNDED" BEAT (sequence AFTER S5/S7 in the budget).
    One daemon-scheduled evening digest through the SAME notice channel and
    interrupt budget; every claim cited or dropped. FEELS: Muse was *with* them
    through the day.

S9. INTENT ROUTER — ONE intent as the tracer bullet (NOT the whole router).
    Map ONE plain-language intent ("what's left on X" → followup + commitment +
    note search) to its existing command handlers, under tool-calling rules
    (≤5–7 exposed, verb_noun, one-shot), eval:tools-gated incl. a negative
    no-tool control. FEELS: talking to one assistant, not navigating a menu.

### The through-line
Muse feels like JARVIS minus the omniscience and plus a sealed mouth:
competent within a KNOWN scope, showing its work on every claim and every
nudge, asking instead of guessing, drafting instead of sending, interrupting
rarely and reversibly, growing with you VISIBLY — and physically unable to
tell anyone, because nothing leaves your machine. Every honesty constraint is
not a tax on the SF dream; it is the completion of it.
```

---

## Changelog (living doc)

- **2026-05-31** — Created. Folded three sources into one living meta-prompt:
  (i) the multi-agent strategy meta-prompt (local-by-construction × cited
  recall; stop polishing the gate; close the front door); (ii) the SF
  personal-AI felt-experience vision (PART A1 / directive B2) — honest
  confidant not omniscient oracle, 7 felt principles, 9 felt-moment slices;
  (iii) the research-grounded continuous background self-learning design
  (PART A2 / directive B1) — event-enqueued, OS-idle + resource-gated,
  cheapest-first, brake-and-proof-first, reversible/visible/grounded.
  Reconciled the old "freeze RL/reflection" ban into "self-learning is a
  PILLAR — turn it ON, make it RUN, make it FELT, never a sycophant." Sources:
  ReasoningBank, Sleep-time Compute, Reflexion, Voyager, ExpeL, Memento;
  Weiser & Brown calm-tech; Noessel "Make It So" / "Designing Agentive
  Technology".
