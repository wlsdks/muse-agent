---
name: scout-rivals
description: Use when the owner wants to know how Muse compares to the open-source agent landscape RIGHT NOW — what openclaw, hermes-agent, and other notable open-source agents shipped recently, what Muse lacks, or when the parity reservoir feels stale; also as the per-fire entrypoint of a rival-watch loop. Produces judged intelligence only — building belongs to grow-muse/improve-muse.
---

# scout-rivals — date-anchored rival intelligence

One invocation = one **delta scout**: what changed in the rival landscape
since the last scout, judged through Muse's identity lens, delivered as
ledger fuel for the building skills. This skill NEVER builds product code —
its ship is the intelligence itself.

The exhaustive base already exists: the 2026-06-23 teardown
(`docs/goals/competitor-teardown.md`, 420 files → 231 judged opportunities in
`capability-parity-backlog.md` + `capability-parity-judgment.md`). Re-deriving
that ground is the documented waste this skill exists to prevent — scout the
DELTA, never the base.

## The cycle

1. **ANCHOR** — run `date` (never assume); read the watermark block at the
   top of `docs/goals/rival-watch.md` (last scout date, per-repo upstream
   SHAs, roster + reference shelf). `git -C /Users/jinan/ai/<name> fetch
   origin` EVERY roster and shelf clone now — the fire reads today's
   upstream, never a stale checkout. Everything below is scoped to changes
   AFTER the watermark.

2. **SWEEP (delta only, verify-in-code)** —
   - **Named rivals** (roster in rival-watch.md carries repo URLs, SHAs, and
     the persistent local clones under `/Users/jinan/ai/<name>` — `git -C`
     fetch them, never re-clone; a NEW roster member gets a blobless clone
     there). High-velocity repos ship
     thousands of commits per window — sweep RELEASES + CHANGELOG first
     (observed fire 1: 7.8k commits in 3.5 weeks; raw log is for locating an
     implementing file, never the survey) → list genuinely NEW capabilities
     and notable architecture changes. **Sweep legwork may fan out to cheap
     subagents** (model: haiku — one per repo, release/changelog digestion
     and delta listing only); their outputs are DATA to spot-check.
     **JUDGE never delegates** — fit/verdict/edge and roster decisions stay
     with the invoking model. Read the implementing file for
     anything you might judge `build` — a claim you didn't see in code is
     recorded ⚠ unverified and never judged build.
   - **Landscape refresh** (2–3 web searches, anchored to today's date):
     notable NEW open-source **personal assistant** agents with real
     traction. Muse is NOT a coding agent — pure coding agents
     (Devin/OpenHands class) don't enroll; a generalizable mechanism from
     one may be recorded as a mechanism finding if it transfers to personal
     continuity. A newcomer joins the roster only with evidence (stars
     velocity, real releases, working code you spot-checked) — hype posts
     don't enroll.
   - **Papers (optional, when a mechanism needs grounding):** openly
     accessible only (arXiv/open-access — anyone can read and reference).
     A paper is mechanism evidence, not a finding by itself; distill the
     mechanism and judge its transfer like any other item.
   - Cross-check every "Muse lacks X" against Muse's actual code
     (codegraph / `git log`) — the June snapshot's `status` column and your
     own assumptions both go stale; a gap Muse already closed is a ✓ flip,
     not a finding.

3. **JUDGE (the existing lens, unchanged)** — for each verified delta item:
   **fit** core/adjacent/off-strategy for a single-user, LOCAL, grounded
   personal companion; **verdict** build/maybe/skip; **edge** does it
   strengthen the grounding/shows-its-work edge. The 51 existing ⛔ skips
   are precedent: multi-tenant/cloud-scale/fail-open features are
   off-strategy no matter how shiny. Never make a cloud vendor the runtime
   owner.

4. **DELIVER (ledger, not essay)** —
   - `build`/`maybe` capability items → append rows to
     `capability-parity-backlog.md` in its row format, tagged `[scout
     YYYY-MM-DD]` — `build` rows are grow-muse rung-4 fuel; `maybe` rows
     stage the reservoir until re-judged `build`.
   - Rival hardening/reliability tricks Muse lacks → one ◦ line each in
     `docs/goals/backlog.md` tagged `→improve-muse`.
   - Update the rival-watch.md watermark (date, SHAs, roster changes,
     queries run) and prune anything the delta obsoleted.
   - Commit the ledger updates (docs commit) and push on green gates.
     Interactive session: also give the owner a short verdict summary
     (what's new, what matters, what we're skipping and why).

## Guardrails

- **Delta-only:** ground marked 재스카웃-금지/exhausted is not re-derived;
  the watermark is the fence. An empty delta is a VALID outcome — record
  the watermark bump and say so (unlike the building skills, this one may
  finish with "nothing new upstream").
- **Verify before judge:** numbers, benchmarks, and feature claims from
  posts/READMEs are ⚠ unverified until seen in code or reproduced.
- **Identity lens binds:** the judgment file's fit/verdict/edge criteria,
  not feature envy. Muse's trust floor is the moat, not a checklist gap.
- **No product code:** findings are fuel; building them is grow-muse /
  improve-muse's job. Cross-skill tags, never inline fixes.
- **🚨 AGPL quarantine (khoj and any future AGPL repo):** read for IDEAS
  ONLY — never copy a line of code, a comment, a schema, or a prompt
  string into Muse or into a ledger row's proposal text. Findings sourced
  from an AGPL repo must describe the MECHANISM in your own words and
  carry an `[AGPL-source: ideas-only]` tag so the building skills know.
  One copied line puts the whole product under network copyleft.

## Rationalizations (reject on sight)

| Excuse | Reality |
|---|---|
| "철저하게 전체를 다시 뜯자" | The base teardown is done and judged. Delta from the watermark only. |
| "README/블로그가 그렇다니까" | Unverified ⇒ ⚠, never `build`. Read the implementing file. |
| "그들이 하니까 우리도" | Fit lens first — 51 skips exist because rivals serve multi-tenant cloud. |
| "찾았으니 바로 고치자" | Scout ships intelligence, not code. Tag it for the building skills. |
| "델타가 없네, 억지로 만들자" | An empty delta is a valid, honest outcome. Bump the watermark and stop. |
| "khoj 구현이 딱 맞는데 조금만 갖다 쓰자" | AGPL — 한 줄도 금지. 아이디어를 자기 말로 재구현하거나 버린다. |

Golden set: [`evals.md`](evals.md).
