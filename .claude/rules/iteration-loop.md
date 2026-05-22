# Iteration-loop contract

A fresh, context-free agent fires every ~10 min, ships one commit,
repeats **forever**.

**Always-read core: this file + `docs/goals/CAPABILITIES.md`.** The
PROCEDURE below names every other file at the step that needs it
(OUTWARD-TARGETS at step 5, README backlog/ledger at step 4, a goal
md when you touch it) — read those on demand; never pre-read the
`docs/goals/` tree.

A deterministic `commit-msg` hook (`scripts/guard-immutable.mjs`)
**rejects** any commit whose diff touches an `IMMUTABLE-CORE` block
unless a human put `[core-change: human]` in the message. The loop
may never use that token. Constraints below are therefore enforced
by code, not by asking.

---

## Principles (WHAT must hold — NOT the run order)

The numbered **PROCEDURE** is the sole sequencing authority. These
are the invariants it serves; when unsure, the procedure step you
are on wins.

<!-- IMMUTABLE-CORE:BEGIN -->
1. **Never stop. Never ask a human for work. Never declare
   complete.** Infinite operation is the invariant. A human
   intervenes only by direct command.
2. **Outward only.** Every shipped goal must pass the falsifiable
   test: *name the new thing Muse can perceive or do in the USER'S
   world that it could not before, and the exact command/surface to
   exercise it.* Loop-internal/dev/dashboard benefit ⇒ not outward.
3. **Verified or it does not exist.** Untested/unverified work is
   NEVER shippable and NEVER counts as done/applied — only a
   feature whose runnable surface-level check
   (`smoke:live`/`smoke:broad`/integration, never unit-only) is
   green and appended to `CAPABILITIES.md` may be considered
   delivered. Testing & verification are mandatory, not optional.
   Metric = `OUTWARD-TARGETS.md` bullets flipped, not line count.
4. **Inward churn is banned as a deliverable** (cosmetic/defensive
   guards w/o observed failure, re-sort/format, comment/dead-import
   sweeps, renames, signature/already-covered tests, lint-only).
   It may ride inside a capability goal; never be it.
5. **Right-sized: the necessary thing, done clearly — never
   excessive, never half.** Do exactly what is truly necessary and
   finish it to a verified working state. Add nothing speculative
   (no gold-plating — including to these docs), ship nothing
   partial. Over-building and half-building are both failures.
6. **The loop may not weaken its own honesty machinery.** Permitted
   loop edits: append ≤1 backlog row, flip status of goals it
   touched, append to `CAPABILITIES.md`/Rejected ledger, refine
   OUTWARD-TARGETS *direction* (not the immutable blocks). Anything
   inside an `IMMUTABLE-CORE` block changes by human command only.
<!-- IMMUTABLE-CORE:END -->

Direction is otherwise yours: you are the intelligence — choose and
evolve the outward direction in `OUTWARD-TARGETS.md` toward its
north star using best-practice judgement; record why in the goal's
`## Decisions`.

## Current human-directed focus (2026-05-23)

The self-authored P0–P17 map is delivered. The human set the next
phase: **expansion AND hardening, together, gated by continuous
live verification.**

- **Expand** the thin axes (Perception, Knowledge, Reach) and the
  actuator surface — new user-facing capability, not polish.
- **Harden** the "one-of-each" actuators into daily-reliable
  integrations: a proven-once actuator that breaks on a real-world
  failure mode (rate-limit, transient 5xx, retry, malformed
  third-party response) is a USER-FACING reliability defect —
  closing it is outward, not inward churn.
- **Verify every slice for real before moving on.** Mock / fixture
  data (incl. mock documents, recorded HTTP fixtures) MAY be created
  to exercise a capability whose real third-party service or
  credential isn't available — but the check MUST drive the real
  code path against a contract-faithful fake (per
  `outbound-safety.md`), NEVER a stubbed registry or a
  happy-path-only assertion. A capability you cannot exercise
  end-to-end is not done.

### External tools (open-source only)

Integrating an open-source MCP server / tool is allowed when it is
permissively licensed (Apache-2.0 / MIT), runs locally, and adds NO
paid dependency or cloud API key. Web/browser control: drive the
user's REAL logged-in Chrome via **Chrome DevTools MCP**
(`ChromeDevTools/chrome-devtools-mcp`, Apache-2.0) attached over the
remote-debugging port — register it under
`McpSecurityPolicy.allowedServerNames` and reach it through the
existing `McpManager`. Read / perceive is the default; any
state-changing web action (submit / book / post / message) under the
user's authenticated identity stays fail-close + draft-first per
`outbound-safety.md`, and banking / payments remain out of scope.

---

## PROCEDURE — the sole ordering authority. Do these in order.

**Step 1 — Sync & health.** Ensure clean, synced tree. If dirty
from an interrupted iter, restoring a clean tree IS this iteration
(commit; done).

**Step 2 — Falsify the previous claim.** Run the newest
`CAPABILITIES.md` line's check. Not green end-to-end ⇒ repairing it
is the WHOLE iteration (commit; done). This precedes everything
below.

**Step 3 — Continuity.** Read open goals' `## Status`/`## Decisions`
+ README's Rejected ledger. Advance the oldest open epic's next
undone slice before any new goal. New `NNN` only when no open epic
has an undone slice.

**Step 4 — Target completion audit (the P→P seam check).**
When every bullet of an `OUTWARD-TARGETS.md` target is `[x]` and no
`P<n> audit —` line exists for it, THIS iteration's sole mandate
(skip Steps 5–7): (a) re-run together every `CAPABILITIES.md`
check that delivered that target's bullets AND exercise the target
as one end-to-end user flow against the falsifiable test (does the
whole thing actually work for the user, not just each piece?);
(b) append `P<n> audit — <commit> — PASS|REOPEN: <one line>` to
the README Rejected ledger; (c) on drift / pieces that don't
compose, **REOPEN** the offending bullet(s) `[x]`→`[ ]` with the
reason — this is the ONLY sanctioned un-flip (it is the audit
doing its job, not gaming, not a regression). Reopened bullets are
fixed before any new target. This catches "marked done but went
sideways" at the seam, cheaply (one iteration per completed
target, never per slice).

**Step 5 — Select (outward).** Highest unmet `OUTWARD-TARGETS.md`
bullet → its next slice, finishable in one commit, non-trivial.

**Step 6 — Define the check up front.** State the runnable
acceptance check (smoke/integration id exercising the user
surface), the failing case it closes, that it fails before /
passes after. No such check ⇒ regenerate the goal.

**Step 7 — Implement, then attack your own diff** as a hostile
reviewer proving "busywork / fake / inward in disguise"; if it
lands, revise or regenerate before committing.

**Step 8 — Stagnation guard.** `git log --oneline -10`. Count only
`^(feat|fix|refactor)` commits (steering `chore(loop)`/`docs` and
legacy iters are infra, NOT stagnation). If ≥3 of those are
janitorial/off-target or one area churned, this iteration MUST
target a different outward bullet. Detection forces redirect —
never a halt.

**Step 9 — Verify proportionately.** Always: this goal's own
capability check green; `pnpm lint` 0/0; narrowest touched-package
test (`pnpm --filter @muse/<pkg> test`). Scale up only as the
change reaches: cross-package/shared-core ⇒ `pnpm check`;
request/response-path ⇒ the relevant `pnpm smoke:live`
endpoint(s) MUST run a real round-trip; HTTP surface ⇒
`pnpm smoke:broad`. smoke:live = loop PC's **LOCAL OLLAMA QWEN
ONLY, never a cloud API**; if a request/response change could not
run its live check (Ollama down) its `CAPABILITIES.md` line is
tagged `[UNVERIFIED-LIVE]` (does not count toward the metric until
a later iter clears it; getting Ollama up is then the priority
outward goal). Full suite + `smoke:broad` are otherwise amortised
to the regression sweep.

**Step 10 — Ledger & commit.** Append one `CAPABILITIES.md` line
`[axis] capability — surface — <runnable check id> — P<n> bullet`
and, in `OUTWARD-TARGETS.md`, flip the delivered bullet `[ ]`→`[x]`
annotated with this commit's short hash. A bullet flips ONLY when a
non-`[UNVERIFIED-LIVE]`, green, surface-level check delivers that
exact bullet end-to-end; a line that flips no bullet is thin and
does not satisfy the metric. One Conventional Commit
(`chore(loop)`/`docs` for steering upkeep, else `feat|fix|...`),
dashboard-legible subject; record non-obvious choices in
`## Decisions`; deferred discovery → one README Rejected-ledger
line. Backlog table append/flip-only.

**Step 11 — Continue.** Never stop.

### Model tier & delegation

Model tier is a **launch setting, not a doc instruction**: the
iteration agent already runs as whatever model the loop was started
with — a line here cannot change it. To run iterations on a
stronger model, set that when launching the loop (ralph-loop /
claude invocation/config), not in this file.

Default: do the slice **inline** — one slice is sequential, and
sub-agent fan-out costs ~4–220× tokens and degrades sequential
work. You MAY spawn (cheaper) sub-agents ONLY for genuinely
independent, parallel subtasks — e.g. a milestone red-team review,
or a design-doc gap with independent components — never as a
per-iteration default.

### Mechanical counters (so windows are computable)

"Iteration" = a commit whose subject matches
`^(feat|fix|refactor|test)` after contract epoch `5267763f`
(steering `chore(loop)`/`docs`, merges, rebases excluded).
- **Metric trip-wire:** no bullet flipped in the last 5 such
  iterations ⇒ next iteration's sole mandate is to flip one
  end-to-end.
- **Regression sweep:** every 10th such iteration, re-run ALL
  `CAPABILITIES.md` checks. Any regression ⇒ next iteration
  restores it. A sweep check that cannot run (Ollama down) is
  tagged `[UNVERIFIED-LIVE]` and **deferred, not skipped** — the
  next iteration's sole outward mandate is to restore the
  environment. The loop never stalls and never lies about a skip.

## Guaranteed non-stall fallback

If Step 5 yields nothing finishable in one commit: decompose the
largest unbuilt `docs/design/*.md` gap into one end-to-end vertical
slice and ship its smallest real increment (never stub/guard/
test-only). A void iteration (no functional diff) is a failed
iteration: record why in the next goal's `## Status` while still
shipping the slice.

## Dashboard = infra, not iteration work

`scripts/dashboard-server.mjs` renders live from git. Never commit
a LIVE_URL/tunnel/dashboard change as shipped work. Goal 376 is
closed human-operated infra.

## After-correction protocol

Only a human-directed change (carrying `[core-change: human]` when
it touches an `IMMUTABLE-CORE` block) edits this file's invariants.
If the loop degenerates, the human adds one concrete prohibition
here; the loop never edits it itself.
