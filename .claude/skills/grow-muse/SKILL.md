---
name: grow-muse
description: Use when deciding what NEW user-facing capability to build next for Muse — the owner asked for growth, a daily flow dead-ends because a capability doesn't exist, or a growth-loop fire. For defects or debt in existing behavior, use the bounded maintenance flow in muse-dev-patterns instead.
---

# grow-muse — the growth cycle

One invocation = one new user-visible capability slice, end-to-end: source →
compare → design-gate → build → verify → push. Existing defects follow the
bounded maintenance flow in `muse-dev-patterns`.

Every slice MUST carry a one-sentence **user story** — "Jinan asks X / lives
situation X, and Muse now does Y." No user story ⇒ filler, drop the item.

**Boundary (one item, one owner):** MISSING capability → here.
Working-but-poor UX of an existing surface → here (usable and correct, just
clunky — slow flows, confusing labels). BROKEN — including failing its
function without erroring (unreadable, dead affordance, wrong output) —
follows `muse-dev-patterns`; maintenance debt found mid-build gets one
`- [open] for=maintenance :: ...` record in backlog.md and is not absorbed
into the slice.

**Standing authorizations (Jinan 2026-06-27, this skill only):** push on
green verify (never red); auto-pick — but new outbound send classes,
privacy-posture changes, and product-boundary calls are ALWAYS ⏳ (skip
with the exact question recorded, never guess); scope a real capability,
not a stub.

## The cycle

1. **ORIENT** — `pnpm self-eval` red ⇒ do NOT build growth. Follow
   `muse-dev-patterns` to reproduce and repair the blocking regression as a
   bounded maintenance slice. Else check recent log; is Ollama up?

2. **SOURCE — take the FIRST rung that yields:**
   1. **Owner's stated direction** — an explicit ask this session, or a ★
      directive in memory/strategy docs. Stated intent outranks anything inferred.
   2. **Dogfood friction (≤5 min probe):** where does a real daily flow
      dead-end because the capability doesn't exist? ("I wanted to ask Muse
      X and there was no way to.")
   3. **North-star gap** — `docs/strategy/attunement.md`: which stage of
      thread → Continuity Pack → outcome → adaptation is still
      substrate-only? Build the missing stage; NEVER relabel existing
      substrate as the loop.
   4. **Parity reservoir** — grep `internal/goals/growth-backlog.md`
      filtered by `judgment-lens.md` (build/core/strengthens
      only; never full-load). Cross-check git log + codegraph first —
      already shipped ⇒ flip ✓, keep sourcing. Reservoir dry or stale
      (rival-watch.md watermark weeks old)? The refill is a `scout-rivals`
      run — never a deeper dig through stale ground, and never scout as a
      routine prelude: rungs 1–2 (the owner's life) outrank rivals by design.

3. **COMPARE (anti-vibes gate)** — judge the top candidates on four
   dimensions and record the line: **D** daily felt value · **T**
   trust-floor effect · **N** north-star advance (a generic-assistant
   feature any product could ship rates low) · **C** cost+risk (one-shot
   local-model tool feasibility, surface area, deps). **Anchors or the pick
   is INVALID:** D quotes the concrete observation or owner sentence — no
   evidence ⇒ D is weak by definition, not by opinion; C names countable
   facts (packages touched, new deps, new tools).

   State in one sentence **why the pick beats the runner-up on the dimension
   where they differ most**, and one line for each other rejection. That
   sentence is the artifact — an arithmetic score is not, because a formula
   over four self-assigned 1–5 numbers reliably produces whatever ranking
   was already intended and reads as rigour while doing it. Comparison on
   named dimensions with cited anchors is the part that catches a bad pick.
   Interactive: show the compared top-3, then proceed. Loop: the comparison
   goes in the commit body.

4. **DESIGN GATE (M+ scope)** — acceptance criteria + seam sketch first
   (`.claude/harness/handoff.md`), then an independent adversarial
   design review (wrong-layer? trust-floor violation? one-shot
   tool-calling feasible? simpler alternative?). Small slices skip the
   reviewer, never the written criteria.

5. **BUILD + VERIFY** — per `.claude/harness/dev-loop.md` §2. A new tool
   ships with the `tool-calling.md` checklist + an `eval:tools` case
   STABLE k=3. **Live-path proof is mandatory** — a handler the model
   never selects, or a flow never driven end-to-end, is not delivered
   (`smoke:live` / real-browser / live probe). Independent evaluator is
   MANDATORY (growth is user-visible by definition). **Gate-delta:** the
   named gate/battery moved, or it's `⚠ shipped-but-insufficient`.

6. **SHIP + CURATE** — one Conventional Commit (user story + the comparison +
   evidence in body), push on green. Flip the source row ✓ (growth-backlog)
   or move it to `backlog-archive.md` (backlog items); prune ≥1 stale line.

## Rationalizations (reject on sight)

| Excuse | Reality |
|---|---|
| "The user story can come later" | No user story ⇒ filler. Write the sentence or drop it. |
| "Pick by gut feel" | An uncompared or unanchored pick is invalid. Name the dimension it wins on. |
| "It's in the reservoir, so it's valuable" | Reservoir is rung 4 and still needs the comparison + freshness. |
| "Relabel substrate as attunement" | ROADMAP ≠ shipped claim. Build the missing stage. |
| "Unit tests are green, so it's delivered" | Live-path proof or it doesn't exist for the user. |

Golden set: [`evals.md`](evals.md) — grade outcome shapes, grow from real misses.
