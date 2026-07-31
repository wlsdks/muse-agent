# loop-creator — CHANGELOG

A version-by-version record of the skill + its bundled `references/loop-engineering.md`
contract. After running loops extensively, cross-reference this history against the
per-loop journal (`internal/goals/loops/<slug>.md`) fire results (each entry stamped
`skill vX.Y.Z`) to see what made output good or bad, and improve accordingly.
(The old shared `loop-digest.md` was deleted 2026-07-18 — see git history.)

> Loose SemVer: **major** = design-skeleton change, **minor** = new guard/behavior,
> **patch** = wording/refactor.
> On any change, bump SKILL.md's `version` and add one entry here.

---

## 3.1.0 — 2026-07-18

Six hardenings from fable's own adversarial review (including live behavioral-test
measurement): ① blocks three literal-text blocks in the tier rule §3.4 (a measured case
where a placeholder induced improvised ad-libbing — the "self-merge to local main" case)
② self-termination: once a fire meets every stop condition, it CronDeletes itself + marks
INDEX COMPLETE + sends a final notification ③ two consecutive no-output fires right after
registration auto-unregisters the loop (prevents an hourly burn from a broken loop) ④ the
3-fire notification now carries 3 loop-health metrics (ship rate, rollback count, (pkg,kind)
spread — computed by grepping journal meta, replacing "watch the loop" for an unattended
loop) ⑤ a crash-leftover worktree is removed with `--force` then recreated ⑥ a
single-source note in the contract doc (the skeleton in SKILL.md wins — blocks dual-source
drift).

## 3.0.0 — 2026-07-18

Redesign on Jinan's direction: a full skill rewrite after a fresh web survey as of
2026-07-17 (practitioners, companies, research — a haiku sweep, then an independent
fable verification pass). Kept: deterministic gate first, independent Opus judge,
(pkg,kind) ratchet, mutation-first, worktree hygiene, JUDGE-DRILL, the unattended-loop
rule, budget caps. New: owner-emphasis priority (a hard rule), a no-progress breaker,
a ban on LLM-only completion verdicts, a codified fresh-context (Ralph) pattern, a
mandatory independent-verification step for research numbers. Removed (excess harness):
the paper-scout block, three overlapping selection-rule descriptions collapsed into a
single "selection discipline", duplicated model tiering, and a dependency on a
nonexistent `/loop` replaced with `CronCreate`. The fire-prompt skeleton shrank ~40%
(zero guard loss). All rationale now lives in references §7 (verified primary sources
only; unverified claims quarantined). The already-registered loop (`097e9e4f`) is
unaffected — this applies starting with the next registration.

## 2.1.1 — 2026-07-18

An owner-emphasis-priority guard (§1 + §3.5 checklist). From a measured miss on
builder-evolution fire 1: the registration prompt's slice-priority logic let a "value
heuristic" (a bug hit 3 times that day) outrank the owner's explicit emphasis
("harden the builder"), so it picked server supervision first and drew an owner
correction. Now the theme's primary track must be pinned as priority ② as-is, and
secondary categories must be explicitly demoted, or §3.5 fails.
(Note: two same-day journal entries were pre-stamped v2.1.1 — this entry is that
version's actual substance.)

## 2.1.0 — 2026-06-20
**Codifies a ban on blocking questions during an unattended fire (⑥).** Jinan's
observation: all 6 concurrently-running loops blocked on Jinan with `AskUserQuestion` at
a direction fork (vein thinning, theme repoint, EXHAUSTION). Root cause: the generation
prompt (§3 skeleton) repeated non-blocking guidance for *regular 3-fire reviews*, but
never once pinned "decide for yourself, don't ask" as a hard prohibition at a *direction
fork* → SessionStart's using-superpowers/clarify bias pushed the model toward
`AskUserQuestion`. The correction was only recorded in the `feedback_loop_self_decide`
memory note, never reflected in the skill. An unattended cron has no one to answer, so a
blocking question is a deadlock.
- **New ⑥ unattended rule added to the §3 skeleton** — blocking tools (`AskUserQuestion`,
  `EnterPlanMode`, etc.) are absolutely forbidden; even at a direction fork, decide the
  pivot/stop-and-continue yourself; human review happens only via the §⑤b async surface.
  A single clarifying question for an ambiguous fork is allowed only at *registration
  time* (the §input-interpretation line also disambiguates this).
- **② EXHAUSTION hardened** — explicitly bans `AskUserQuestion` at a vein-exhaustion/theme-
  repoint fork; repoint candidates surface asynchronously via the journal + PushNotification.
- **Added loop-engineering.md §3-2 (c)** — codifies in the contract body that non-blocking
  also applies at a direction fork.
- **Added a ⑥ check item to the §3.5 self-verification** — registration FAILs if the
  unattended rule is missing.
- Note: does *not* retroactively apply to *already-registered* cron prompts — an active
  loop must be re-registered to pick this up.

## 2.0.0 — 2026-06-20
**Design-skeleton upgrade from 489-fire empirical data + fresh 2026-06 primary research**
(Jinan's direction: "sweep it clean with the accumulated record/data plus the latest from
the web"). After the v1.14.0 registration, 8 loops ran 16–148 fires each over a week,
accumulating a journal (~1.1MB); mined that plus primary research published/deepened
since the 6/13 sources to strengthen the contract. The mechanism skeleton (maker≠judge,
drills, autonomy tiers) is preserved; only the *edges* the data pointed to were sharpened.

Guards from empirical (journal-mining) evidence:
- **§4.5-11 Concurrent-loop operating hygiene (mechanical).** 489-fire finding #1: the
  unguarded cost when N loops run concurrently on shared main/one box (another loop's
  uncommitted changes getting swept in, false-red checks, conflict-marker commits,
  strandedness). Moved from "the operator has to remember" to **mechanical guards**:
  isolated worktrees, explicit `git add` paths (`-A` forbidden), a clean-main
  precondition (`git stash` forbidden), machine-saturation awareness (a 5000ms
  timeout/OOM triggers an isolated solo re-run), and a marker/byte scan before commit.
  Also pinned into the ⑤ generation prompt.
- **§4.5-9 Diversity RATCHET corrected from value-class to (pkg, kind).** Empirically,
  value-class is a per-theme constant (all 106 codebase-quality fires were `refactor`),
  so it's useless as a diversity signal; the axis that actually ratcheted was (pkg,kind)
  (tool-hardening fire 47). The gate now sits on (pkg,kind); value-class is demoted to
  descriptive only.
- **§4.5-3 MUTATION-FIRST for *every* slice.** The judge's teeth were proven only in
  drills, while "safe" slices looked dull under all-PASS → every slice's new test must
  now go RED→GREEN (the same adversarial pressure as a drill).
- **§4.5-12 Sibling audit.** Fixing one call site while a sibling instance recurs
  (date-rollover: tasks→calendar→time; SSRF: IPv6→SIIT→NAT64) → siblings in the same
  class must be enumerated + patched (or backlogged) in the *same* fire.
- **§4.5-10 Marginal-value floor.** Pulls the exhaustion-escalation trigger not on "zero
  bugs left" but on marginal-value < verification-cost as the *earlier* signal
  (correcting the tool-hardening fires 123–145 locale-utility ~8-fire padding drift).

Hardenings from primary research:
- **§3.6 Unattended-loop security (new tier-1 section).** Unattended security for *the
  dev agent driving the loop*. Agents Rule of Two (Meta 2025-11, §3.5's tier-boundary
  decision rule) · untrusted text is quarantined as data (Snyk "Clinejection" 2026-02: a
  real incident — issue-title injection → malicious install → Actions cache poisoning →
  release-token theft) · install/build hooks are sandboxed · auto-pulled skill/config gets
  a hidden-Unicode scan (TrapDoor; 36% of skills flawed). Source: arXiv 2510.09023.
- **§3-1 Adaptive verification.** Static checklists are bypassed >90% by adaptive attacks
  and 100% by humans (2510.09023) → the judge must re-reason THIS slice's specific
  failure mode every time.
- **§1.5-3 Judge calibration, both directions.** Self-preference marks a failing rubric
  "satisfied" up to 50% more often and skews scores ~10 points (2604.06996), and this
  persists even controlling for ability (2508.06709) → with an Opus ceiling, same-family
  judging is unavoidable, so the drill is mandatory, not optional. Under-confidence
  (false-FAILs correct work 44.4% of the time, dropping to 7.7% with calibration,
  2606.14211) → a FAIL must name a *concrete* violation; a vague "not sure" is not
  grounds.
- **§4.5-13 Failure distillation (ReasoningBank, 2509.25140, +34.2%/−16%).** A one-line
  reusable `lesson:` on every rollback/no-ship.
- **§1 Sub-agent fan-out rule.** Single ≥ multi at equal budget (2604.02460); hand-offs
  should be linear, not a converging DAG (2605.08647).
- **§1 Budget = a rot trigger.** Effective window ~300K (Chroma context-rot); a long fire
  externalizes state to disk (Anthropic "Effective harnesses for long-running agents":
  compaction alone isn't enough).
- **§6 Meta-loop (new) — the protocol by which the contract evolves from data** (from
  Jinan's question, "shouldn't we keep a steady record?"). Pins down what made v2.0
  possible (version-stamped journals + grep-able meta) as a *repeatable* protocol:
  re-evaluation triggers on a *countable* condition, not prose (~100 cumulative fires /
  new primary research / Jinan's direction / ≥3 repeated failures); the recipe is
  journal-mining + web cross-check + **an independent maker≠judge review** (a
  sub-agent's numbers get an independent first-pass verification — this review is what
  caught fabricated self-preference numbers in v2.0). SKILL.md's versioning note points
  to §6.
Kept (guarding against over-correction): the drill hard-counter (the healthiest
mechanism across 489 fires — it never slipped once), the isolated-journal protocol,
honest-defer/exhaustion (verified to actually work), Tier1/2 + the hard floor.

Skill structure (from Jinan's question, "should SKILL.md split once it gets long?"):
checked against 2026 Anthropic best practice — **already a model split** — SKILL.md
(207 lines, comfortably under the 500-line cap) is the public API, and
references/loop-engineering.md (345 lines) is the detailed contract (progressive
disclosure). No further split needed now; if SKILL.md passes ~300 lines, move the
skeleton into references then.

## 1.14.0 — 2026-06-13
**Per-loop logging protocol — removes cross-contamination/collisions across 4 concurrent
loops** (Jinan's direction). Background: 4 loops were appending to one shared
`loop-digest.md`/`backlog.md` → a merge conflict on every fire, plus "version ↔ output"
correlation contaminated by other loops' entries (a TOOL fire's RATCHET tally mixing with
a cognition fire's). Applied the 2026 multi-agent-observability consensus (agent-ID-
stamped structured logs + isolated paths as the fundamental control for "failure
attribution + lossless parallel editing").
- **Per-loop journal** `internal/goals/loops/<slug>.md` — append-only, one per loop
  slug (theme). Date/fire/version live in *entry metadata* (not the filename). Fixed
  schema: `## fire N · date · skill vX.Y.Z · commit` + `meta:` (value-class, pkg, kind,
  verdict, firesSinceDrill — **grep-able counts**) + `ratchet:` + what/why/review-point/
  risk.
- **backlog = a thin shared queue** (open ◦ items + a `✓ Fixed` one-line dedup ledger).
  Per-fire Done detail now lives in the journal — removes the giant Done blocks that were
  causing backlog bloat/conflicts (going forward).
- **INDEX.md** a thin aggregator (one line per loop, each loop updates only its own
  line) + **loops/README.md** the protocol doc.
- **Migrated** the old shared `loop-digest.md` (830 lines, 68 TOOL + 39 cognition
  entries) into per-loop journals; the original is left as a tombstone (pointing an
  un-re-registered loop to the new location). Sources: Augment "Git Worktrees / Debug
  Parallel Agents", MLflow "Production AI Agents 2026", arXiv 2604.09409 "Do AI Coding
  Agents Log Like Humans?", 2603.29678.

## 1.13.0 — 2026-06-13
**Complex-coding escalation tiering + Markdown-body cleanup** (Jinan's direction).
- **Complex business code → Opus 4.8** (§1.5-2, table). Only routine/mechanical work
  (a clean single file) stays on Sonnet; multi-file edits, architecture, layered
  dependencies, unfamiliar or tangled code, and red-test debugging escalate to Opus.
  *Mechanical escalation signal* (better than self-assessed difficulty): **N+ files
  touched, or a currently-red test, means Opus.** Rationale (2026 web consensus): Sonnet
  handles most coding basics well (higher SWE-bench, 30% fewer tokens), but complex/
  high-stakes work escalating to frontier is standard practice; on complex tasks, the
  rework cost of a cheap model's "almost right" answer exceeds one frontier call — so
  escalation is actually the economical choice. Sources: NxCode "Opus or Sonnet for
  Coding 2026" (nxcode.io/resources/news/claude-opus-or-sonnet-for-coding-decision-
  guide-2026) · Unblocked "Model Routing for Coding Agents"
  (getunblocked.com/blog/model-routing-coding-agents) · arXiv 2604.07494 "Triage: Routing
  SE Tasks to Cost-Effective LLM Tiers via Code Quality Signals".
- **Markdown-body cleanup** (Jinan's direction: "the why-we-did-it log belongs in one
  place, the skill itself should stay clean"): removed provenance (date headers, "added
  from a live dogfood/cold-eval finding", fire-N measurement notes, incident write-ups)
  from SKILL.md and loop-engineering.md §4.5, leaving each guard as *just a crisp rule +
  a short why*. History/rationale now live only in this CHANGELOG.

## 1.12.0 — 2026-06-13
**Full removal of Fable-5 + 3 hardenings from a 28-fire cold evaluation** (Jinan's
direction). Background: after 28 fires (v1.11.2), an Opus adversarial review scored B
(B-flat) — the floor (safety) was A-grade, but the ceiling (generative value) converged
on a `@muse/mcp` micro-fix monoculture (half of all EXPANSION items were zero). Also,
Fable-5 was unavailable at runtime for ~6 consecutive fires.
- **Removed Fable-5 → hard-pinned to the Opus 4.8 strong tier.** Scout/plan/design/
  ambiguous-fork/④b adversarial verification = Opus 4.8 (`claude-opus-4-8[1m]`). Removed
  every `fable` reference from the model-tiering table, generation prompt, §1.5, §4
  checklist, and lever list. (Resolves W3: when Fable-5 was down, maker+judge would
  silently collapse onto Opus with *no record* of the weakening — this removes that by
  *stabilizing* the tier on Opus and stating the compensating controls explicitly.)
- **Honest maker≠judge (§1.5-3, table).** Since Opus is the ceiling, an Opus-build ↔
  Opus-judge pair is *the same model* — states plainly that the separation is carried
  not by "a different model" but by **an independent sub-agent (fresh context) +
  adversarial framing + a judge-failure drill**. The judge is always a separate,
  independent instance from the builder.
- **W1 VALUE-CLASS RATCHET (§4.5-9 + ② + ④b + ⑤b).** Corrects a failure where
  KIND-diversity was satisfied by rotating bug KINDs while value stayed monotonic. Counts
  the last 8 fires by (package × value-class {micro-fix, new-capability, wiring,
  refactor}); ≥6/8 same-package micro-fix forces a different value-class/package on the
  next fire, and the ④b judge FAILs a violation. Turns "value first" from unmeasurable
  prose into a *countable* property. + §4.5-10 EXHAUSTION (2 exhausted scouts → don't
  burn a 3rd, switch value-class or end honestly).
- **W2 JUDGE-DRILL hard-counter (§4.5-5 + ⑤b).** Corrects a measured drift where "~10
  fires" in prose slipped to 14 fires (drills at 10, 21, 31, 45). The RATCHET line now
  carries `firesSinceDrill=N`; `≥10 OR ≥8 consecutive allPASS` forces an undeferrable
  drill.
Kept (guarding against over-correction): the maker≠judge gating verifier (it has caught
real adjacent gaps), RATCHET/write-back/post-gate byte-hygiene, honest-defer, the KIND
diversity guard (the problem was one layer up, at value-class).

## 1.11.2 — 2026-06-13
**Adds a theme-scope clause to the paper-grounding-first line** (confirmed by Jinan): for
capability/method/research themes, paper-first is right, but for hardening/correctness/
security themes, the security/correctness work itself IS the value — it must not be
deprioritized by getting written off as a "mere bugfix" (fixing prototype-contamination
or contract violations WAS the hardening loop's best output). Removes the conflict where
ambiguity was letting the hardening loop skip its own best output. Also preserves the
"open/public papers only" line Jinan added (arXiv/open-access only, reimplement in your
own words, never copy proprietary content).

## 1.11.1 — 2026-06-13
Added a **paper-grounding-first (when possible)** line to generation-prompt ② (preserving
an uncommitted edit that was already sitting in the worktree) — the strong-tier scout
specs an *applicable mechanism + arXiv ID* from a WebSearch-verified 2024-2026 AI-agent
paper, prioritizing paper-grounded capability work over a plain correctness bugfix.
Matches the standing directive [[project_research_application]] and closes the
"small-bug bias" finding from the v1.11.0 evaluation (a concrete instance of
value-first).

## 1.11.0 — 2026-06-13
**5 guards from a live evaluation** (6-fire measurement + cross-checked against Osmani/
Cherny/Karpathy/Anthropic, 2026-06). The mechanism itself was top-tier, but 3 "gate
edges" were weak — all fixed at the prompt/contract one-liner level:
- **The gate now covers the final diff** (§4.5-6, generation prompt ⑤): re-checks
  lint + byte-hygiene on the staged diff after write-back/digest. Fire 1 leaked a NUL
  byte through a post-gate-edit hole, which fire 2 caught — this closes that *proven
  incident*.
- **Decompose-on-defer** (§4.5-7, ②): when a large item is deferred, split it into
  loop-sized pieces recorded in backlog (Anthropic's planner pattern) or explicitly mark
  it "needs Jinan"; deferring twice forces an escalation. Turns the small-bug bias
  (defer being a one-way ratchet) into a pipeline.
- **RATCHET metric** (§4.5-8, ⑤b): one scoreboard-delta line in every fire's digest;
  the notification is the trend (Karpathy's "immutable number").
- **Codified stale-dist recovery** (④): build the touched package first, and if `check`
  fails, the first diagnostic step is a clean-rebuild re-run (2 of 6 fires wasted a
  diagnosis cycle on this exact flake, a lesson already sitting in MEMORY).
- **Judge-failure-drill CADENCE** (§4.5-5): from a one-time drill to a re-drill every N
  fires (10) / version bump, plus the judge PASS-rate in the digest.
Data verdict: 6 fires is enough for a mechanism smoke test but premature for a skill
verdict — instrument it and re-evaluate around 25–30 fires.

## 1.10.0 — 2026-06-13
**Fable 5 for the planning tier** (Jinan's direction): planning/design/ambiguous-fork/
adversarial-verification (the strong-reasoning tier) uses **Fable 5 (`model:"fable"`)
when available**, falling back to **Opus 4.8 (1M, `claude-opus-4-8[1m]`)** when it isn't.
Dev/build stays Opus-or-Sonnet agnostic (routine work delegating to Sonnet still saves
tokens). Updated §1.5 + the generation-prompt model-tiering line + the §4 checklist.

## 1.9.0 — 2026-06-12
**Turned the comprehension checkpoint from a "blocking STOP" into an "async, non-blocking
notification"** (flagged by Jinan — on review, my design was more conservative than the
research warranted). Practitioner blogs (Cherny: unbounded autonomy + async PR merges)
treat review as an *async review surface*, not a *loop halt*. The loop now **never
stops**: the digest is an async log readable any time, and every N fires it no longer
blocks — it just sends a PushNotification and keeps going. Comprehension debt is handled
by a readable digest, not by halting the loop. (§3-2.)

## 1.8.1 — 2026-06-12
Signal-scout hardening (loop fire 6): stops counting an ungrounded non-answer as a
failure — the scout's first real finding turned out to be dev-test noise (an empty
answer). `isFailureEvent` now counts `success===false` first, and excludes only the
ungrounded+empty-answer case. Re-run on real data: 1 cluster → 0. (Core:
`run-log-analysis.ts`.)

## 1.8.0 — 2026-06-12
**Signal-based gap-scout** (Jinan's direction — research showed 2026 mainstream practice
is signal-triage discovery). Turns discovery (§1.3) into a 3-rung ladder: (a) **signal
first** — `scripts/scout-signals.mjs` frequency-clusters `.muse/runs/` failure traces
(ungrounded/failed) → a genuinely-recurring failure becomes the work item, (b) if that's
clean, fall back to code-expansion gap-scout, (c) if both are dry, **report honestly and
stop (no manufactured work)**. Deterministic core:
`apps/cli/src/run-log-analysis.ts` (`analyzeRunLogSignals`, 8/8 behavioral unit tests);
proved on real data — 1,133 traces surfaced a genuine failure cluster
(browser-read ungrounded ×7). improve-muse (e) also updated to the same ladder.

## 1.7.0 — 2026-06-12
**Restructured §1 as "DECIDE THE WORK"** (flagged by Jinan): the skill's job #1 is to
*decide what to do*, and if that's unclear, *actively discover* it. Decision order
(baseline regression → theme + backlog top → **if the theme is missing/thin/absent, run
gap-scout *immediately*, write the discovery into backlog, and proceed**). Promoted
discovery from a conditional ("only when backlog is empty") to **"the #1 move when
unsure"** — "there's nothing to do" is forbidden (don't stop when unsure — scout).

## 1.6.1 — 2026-06-12
Added **handling for a missing backlog.md** to ORIENT (from Jinan's question). States
that backlog is an existing repo artifact the skill *reads*, not one it creates — but if
the file is missing (fresh repo / doc-reset), it creates a minimal skeleton + seeds it
via gap-scout, treated the same as an "empty" backlog. "No file ≠ no work" — never stop.

## 1.6.0 — 2026-06-12 (`8895dae0`)
Turned 4 weaknesses surfaced by a live dogfood evaluation (fires 1–2) into guards
(contract §4.5):
- **Value-first** slice selection (not "whatever's easiest to verify"; a deferral states
  its reason in the digest).
- **Diversity** (no repeating the same KIND 3 fires running).
- **Behavioral acceptance** (declaration/config-only tests are banned → the gating
  verifier FAILs them).
- **Token efficiency** (batch same-kind changes + verification depth proportional to
  risk).
- **Failure drill**: *proves* — never assumes — the gating-verifier FAIL → rollback path
  with a deliberately inert slice.

## 1.5.1 — 2026-06-12 (`1a7ac13e`)
Moved the single-consumer contract `loop-engineering.md` from `harness/` into the
skill's `references/` (reflecting a coupling question). The skill now bundles its own
contract. States honestly that this is a "Muse-native skill".

## 1.5.0 — 2026-06-12 (`623c264e`)
Closed 3 gaps found comparing against practitioner blogs:
- **Autonomy tiers** (Tier1: local commit / Tier2: branch + draft PR, hard floor
  unchanged).
- **Gating verifier** (a separate, strong-tier Opus judge GATEs each commit;
  FAIL = rollback).
- **Comprehension checkpoint** (a digest every fire + a review gate every 3 fires).

## 1.4.0 — 2026-06-12 (`9c03fcbb`)
Added a **fuel check** to ORIENT (≤2 open items on the theme triggers a warning + a
broader-theme suggestion) — found during live verification.

## 1.3.0 — 2026-06-12 (`024ff5ef`)
Hardened via an independent adversarial review: a red-baseline guard (a non-zero
self-eval blocks registration), a warning about concurrent main-loops, a budget cap in
the generation prompt, a `CronList` check for a duplicate-theme cron, an independent
'Done' verdict, aligned worked-example numbering, and clarified `/loop` session-id +
immediate-first-fire behavior.

## 1.2.0 — 2026-06-12 (`07cf8ead`)
Formally incorporated 2026-06 sources (Steinberger, Cherny, Osmani, et al.) and rounded
it out: a **pre-registration self-verification gate** (checklist PASS/FAIL), a worked
example, and a lineage pointer.

## 1.1.0 — 2026-06-12 (`edd505c2`)
**Model tiering** (routine work = Sonnet, design/verification = Opus, judge = a tier
stronger than the worker) — a token-saving lever.

## 1.0.0 — 2026-06-12 (`99c749f2`)
First edition: distilled Addy Osmani's "Loop Engineering" into a Muse contract
(`loop-engineering.md` — 6 primitives, verifiable stop conditions, maker≠judge, 3 major
failure modes) + the generative `loop-creator` skill (theme → fill contract → generate
prompt → register cron).
