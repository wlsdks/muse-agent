---
name: grow-muse
description: Autonomous NEW-CAPABILITY cycle for the Muse repo — source the highest-value missing user-facing capability (진안's stated direction, dogfood friction, attunement north-star gap, vetted parity reservoir), score it on a value rubric, design-gate it, build it end-to-end, verify (maker≠judge + live-path proof), then commit AND push. For hardening/reliability/debt work on what already exists, use improve-muse instead.
---

# grow-muse — the growth cycle (새 가치를 만드는 쪽)

## What this is

One invocation = **one new user-visible capability slice, carried
end-to-end**: source → score → design-gate → build → verify → push. Its
sibling [`improve-muse`](../improve-muse/SKILL.md) hardens what exists; this
skill grows what doesn't. Never mix the two in one slice — a capability
shipped on a shaky substrate and a substrate polished with no user story are
the two failure modes the split prevents.

A capability slice MUST carry a **user story in one sentence** — "진안 asks
X / lives situation X, and Muse now does Y" — plus acceptance criteria and a
nameable gate. No user story ⇒ it is not a capability, it is filler.

- **Boundary:** MISSING capability → here. BROKEN existing surface →
  improve-muse. **Working-but-poor** (functions, but serves the user badly —
  UX/quality of an existing surface) → HERE, because it changes what the
  user can do/feel. One item, one owner — never both, never neither.
- **Solo-loop limitation:** a loop that calls only this skill grows forever
  and never hardens. Pair or alternate with an improve-muse loop.

## Standing authorizations (same deltas as improve-muse — Jinan 2026-06-27)

- **PUSHES** on green verify only. Never red.
- **Auto-picks** (⏳ human forks skipped, never guessed — product-boundary
  calls, security-posture tradeoffs, and anything under `outbound-safety.md`
  are ALWAYS ⏳).
- **Bigger slices** — a real capability, not a stub.

## The cycle

1. **ORIENT** — `pnpm self-eval` first: **a regression outranks all growth**;
   if red, STOP and run improve-muse instead (a product that's broken doesn't
   need a new feature). `git log --oneline -8`; Ollama reachable?

2. **SOURCE — in priority order; take the FIRST rung that yields.**

   1. **진안's stated direction** — an explicit ask from the session, a ★
      directive in memory/strategy docs (`docs/strategy/*.md` current-phase
      items). The owner's stated intent outranks anything inferred.
   2. **dogfood friction implying a MISSING capability** — probe the live
      product as a user (≤5 min): where does a real daily flow dead-end
      because the capability doesn't exist (not because it's broken — broken
      is improve-muse's rung 3)? "I wanted to ask Muse X and there was no way
      to" is the highest-signal growth seed there is.
   3. **north-star gap** — the attunement contract
      (`docs/strategy/attunement.md`): which stage of personal thread →
      Continuity Pack → outcome → adaptation is still substrate-only? Grep
      the contract's open items; never relabel existing substrate as the
      loop — build the missing stage.
   4. **capability-parity reservoir** — `docs/goals/capability-parity-backlog.md`
      filtered by `capability-parity-judgment.md` (`build`/`core`/`strengthens`
      only). RETRIEVAL DISCIPLINE: grep the section, never full-load. Apply
      the FRESHNESS GUARD (git log + codegraph — parity items go stale).

3. **SCORE (the anti-vibes gate) — before committing to the pick,** score the
   top candidates 1–5 on each axis and record the line:
   - **D** — daily felt value: will 진안 notice it this week, unprompted?
   - **T** — trust floor: does it strengthen grounding/correction/legibility
     (or at least not dilute them)?
   - **N** — north star: does it advance attunement/personal-continuity, or
     is it a generic-assistant feature any product could ship?
   - **C** — cost+risk (inverse): local-model feasibility in ONE tool shot
     (`tool-calling.md`), surface area, new deps.
   **Anti-gaming anchors (a score line without these is an INVALID pick):**
   **D** must cite the concrete evidence — the dogfood observation, owner
   quote, or trace that proves "notice this week" (no evidence ⇒ D≤2);
   **C** must name the countable facts: packages touched, new deps, new
   tools. The independent evaluator rejects unanchored score lines, not
   just bad builds. Pick = max(D×T×N/C) with a one-line justification per
   rejected runner-up. In an interactive session show the scored top-3
   before proceeding; in a loop fire, record the scores in the commit body.

4. **DESIGN GATE (M+ scope only)** — write the acceptance criteria + a sketch
   of the seams FIRST (planner contract,
   [`harness/core/handoff-template.md`](../../../harness/core/handoff-template.md)),
   then have an **adversarial design reviewer** (independent subagent) attack
   it — wrong-layer, trust-floor violation, one-shot tool-calling feasibility,
   simpler-alternative. Incorporate or defer. Small slices may skip the
   subagent but never the written acceptance criteria.

5. **BUILD** — per [`harness/host/dev-loop.md`](../../../harness/host/dev-loop.md) §3.
   Non-negotiables that bite hardest on growth work: model-agnostic core
   (no vendor SDK outside adapters), deterministic policy/guards (never a
   prompt), draft-first for anything outbound, a new tool ships with the
   `tool-calling.md` checklist + an `eval:tools` case.

6. **VERIFY (fail-closed, maker≠judge, LIVE-path proof)** —
   - `pnpm test:changed` + build + lint, plus the rung that proves the
     capability LIVE: `smoke:live`/live probe for request-path work (a
     handler the model never selects is not delivered), real-browser
     measurement for web UI, `eval:tools` STABLE k=3 for a new tool.
   - Mutation check on the new tests (RED on mutation, or
     deterministic-by-construction stated).
   - **Independent evaluator** — MANDATORY for growth slices (they are
     user-visible by definition). Uncertain ⇒ FAIL.
   - **GATE-DELTA:** the named gate/battery moved (often: a new battery case
     exists AND passes; a smoke case covers the new path). No delta ⇒
     `⚠ shipped-but-insufficient`.

7. **SHIP + CURATE** — one Conventional Commit (user story + scores +
   verification evidence in the body), `git push` on green. Write-back:
   distill to one ✓ line where the item came from (backlog/parity ledger),
   prune ≥1 stale line, tag discovered hardening debt `→improve-muse` as one
   ◦ line instead of building it here.

## Guardrails (fail-closed)

- **Regression outranks growth** — red self-eval ⇒ hand off to improve-muse.
- **Maker ≠ judge; evaluator mandatory** (user-visible tier,
  `harness.md` risk-tiering).
- **fabrication = 0**, `MUSE_LOCAL_ONLY` posture, draft-first outbound,
  banking permanently out of scope, provider-neutral core — all bind.
- **⏳ human forks:** new outbound send classes, privacy-posture changes,
  product-boundary redefinitions — skip and record, never guess.
- **Product identity:** Muse is a continuing personal AI for ONE person —
  never reduce it to a work assistant / productivity tracker / admin console
  (`product-identity.md`). A capability that only makes the console bigger
  fails N.
- **Concurrent-loop hygiene:** same as improve-muse (rebase-pull, explicit
  adds, rebuild touched deps, never force).

## Forbidden outputs

| Rationalization | Reality |
|---|---|
| "유저 스토리 없이 기능부터" | No user story ⇒ filler. Write the sentence or drop the item. |
| "점수 없이 감으로 픽" | SCORE is mandatory — record D/T/N/C or the pick is invalid. |
| "레저부아에 있으니 가치 있다" | The reservoir is rung 4 and still needs SCORE + freshness. |
| "깨진 것 고치기로 성장 슬라이스 완료" | Defects/debt are improve-muse. (Working-but-poor UX of an existing surface IS growth — see Boundary.) |
| "eval:tools/스모크 없이 '동작함'" | A capability without live-path proof is not delivered. |
| "substrate를 attunement로 재라벨" | ROADMAP is not a shipped claim. Build the missing stage or pick elsewhere. |
| "테스트/평가자 건너뛰고 푸시" | Green verify + evaluator PASS or no push. |

## Evaluation

[`evals.md`](evals.md): repo-state → expected end-to-end behavior. Grade the
outcome shape; grow it from real misses.
