---
title: Personal Continuity first-20 batch dogfood
status: completed
date: 2026-07-17
scope: agent-operated same-session batch plus historical receipt audit
---

# Personal Continuity first-20 evaluation

## Decision

The first-20 raw ledger clears the Slice A numerical kill threshold, but it
does **not** clear an automation gate. Keep Personal Continuity manual and
user-invoked. Do not start proactive delivery or Slice B from this evidence.

- Raw outcomes: `used 12 / adjusted 6 / ignored 2 / rejected 0`.
- Raw use: 60%; rejection: 0%.
- Strict lower-bound use: 10/20 (50%). Deliveries 1 and 7 retain their raw
  `used` receipts but have no concrete task-advancing evidence and are excluded.
- Automation decision: **hold**. Continue manual Slice A evaluation.

This is agent-operated, mostly same-session batch dogfood. It is useful for
finding deterministic presentation failures. It is not longitudinal evidence
that Muse helps across twenty real days, natural return moments, or diverse
daily-life domains.

## Method

Every Pack was built from one explicitly linked exact local task. A `used`
receipt counts as rubric-valid only when the Pack led to a concrete task-
advancing artifact, action, or decision in the session. Merely inspecting note
quality, duplicate titles, or the Pack itself does not count as use.

The first seven historical receipts were audited against task completion
timestamps. Deliveries 10–20 used a fixed four-dimension rubric: grounding,
actionability, adaptation, and end state. No physical purchase, meeting action,
email send, remote push, or other external action is claimed.

## Episode ledger and receipt audit

| # | kind / stratum | raw outcome | concrete evidence or result | strict status |
|---:|---|---|---|---|
| 1 | work | used | Pack-review task stayed open; no distinct advancing receipt | unverified-used |
| 2 | work | used | Linked CLI-review task completed between Pack open and outcome | valid-used |
| 3 | work | used | Linked outcome-gate task completed between Pack open and outcome | valid-used |
| 4 | work | used | Linked inspection task completed between Pack open and outcome | valid-used |
| 5 | work | used | Linked five-pack review task completed between Pack open and outcome | valid-used |
| 6 | life | used | Linked personal-setup review task completed between Pack open and outcome | valid-used |
| 7 | work | used | Linked task was already done before this Pack; no new receipt | unverified-used |
| 8 | work | adjusted | Exact task restored, but next action repeated its title | valid non-use |
| 9 | work | used | Followed Pack command and added concrete notes to the linked task | valid-used |
| 10 | work | used | Verified commit `012c6b86d`, ran Gemini regression 1/1, closed stale task | valid-used |
| 11 | work | adjusted | Compact/direct hid existing meeting subtasks; no meeting artifact advanced | valid non-use |
| 12 | work | adjusted | Contextual output repeated vague email notes; no recipient, draft, or send | valid non-use |
| 13 | life-stress | adjusted | Milk task was exact, but overdue timing and duplicate context were absent | valid non-use |
| 14 | life-stress | adjusted | Contextual notes repeated the task and did not distinguish its duplicate | valid non-use |
| 15 | life-stress | adjusted | Missing-notes command was correct; personal quantity/type could not be invented | valid non-use |
| 16 | life-stress | ignored | Exact grocery task was not used; repeated missing-detail guidance | valid non-use |
| 17 | work | ignored | Test-like `Long-due ISO` task had no meaningful current work action | valid non-use |
| 18 | work | used | Ran source-installer contract tests 5/5 and confirmed Windows `pnpm.cmd` spawn | valid-used |
| 19 | work | used | Verified shared runtime factories; multi-agent 3/3 and API routes 8/8 | valid-used |
| 20 | work | used | Produced this audit, rates, product decision, and follow-up plan | valid-used |

`life-stress` is a reporting stratum only. Its canonical thread kind is
`life`. Four grocery/milk variants test duplicate and missing-context behavior;
they do not establish daily-life breadth.

## What the first 20 show

### Grounding worked

All newly observed Packs used the exact selected task ID. No Pack silently
switched tasks, inferred a replacement, sent anything, or widened permission.
The source-isolation contract is strong enough to keep.

### Actionability is the limiting factor

Concrete engineering titles worked well: deliveries 10, 18, and 19 all led to
completed verification artifacts. Vague personal or communication tasks did
not. At the end of this window the Pack omitted deterministic fields already
present on the exact task—especially `dueAt` and tags—and could not distinguish
overdue context. A vague note could also appear once in evidence and again as
`Next-action notes`, adding repetition rather than reducing a decision. The
post-window follow-up below addresses those presentation defects.

### Adaptation changes form, not usefulness

`adjusted → contextual` successfully exposed task notes or the exact local edit
command. That fixed the title-repeat defect, but it cannot make vague notes
specific. `used → compact/direct` can hide useful existing notes, as delivery
11 demonstrated. `ignored` is acknowledged on the next Pack, but acknowledgement
alone did not improve the selected task.

### The cohort comparison is not causal evidence

Muse reports first five `used 5/5` and next five `used 4/5`, therefore
`regressing`. Under the strict audit those windows are 4/5 and 3/5 because
deliveries 1 and 7 lack advancing receipts. Both directions are lower, but the
interventions are heterogeneous and were not matched across comparable return
moments. Record the signal; do not claim measured adaptation regression.

## Next build order

1. **P0 — keep automation held.** Continue only user-invoked Slice A. Do not
   start proactive delivery or Slice B from this batch.
2. **P1 — exact task state presentation completed.** Carry and render the linked
   task's deterministic due/overdue state and tags without searching or
   auto-linking any unselected source.
3. **P1 — contextual duplication removal completed.** Show user-authored notes
   once, then keep the outcome command; do not echo the same vague text as
   evidence and action.
4. **P1 — collect a comparable longitudinal set.** Use distinct natural life
   and work return moments across dates. Compare matched first/next cohorts only
   after at least ten comparable interventions.
5. **P2 — distribution remains downstream.** The source installer can stay the
   single supported path while manual Continuity usefulness is strengthened.

## Post-window delivery 21

After implementing exact task state and scoped contextual-note suppression, one
additional manual Pack reopened the same exact linked life task
`task_4eb5262c-7f56-4734-a06c-9aa59f991656`. Delivery
`delivery_7b2fdebb-a8e4-499d-9336-3581ea5521ac` displayed the stored timestamp
as `overdue: 2026-06-06T18:00:00.000Z` and the exact escaped tags as
`["구매"]`. No other task was searched or selected.

The explicit outcome is `adjusted`, not `used`: the extra state fixed the known
presentation gap but did not produce a concrete purchase decision, artifact, or
completed action. The task was unlinked after the check. Overall receipts are
now `used 12 / adjusted 7 / ignored 2 / rejected 0` across 21 deliveries, while
the canonical first-20 window remains exactly `used 12 / adjusted 6 / ignored 2 /
rejected 0` and stays manual-only. Repeating the same milk task dozens more
times would not add independent evidence; the next set should use distinct,
natural life/work return moments.

## Promotion rule

The raw kill threshold means “do not kill manual Slice A,” not “ship
automation.” Promotion requires a separate longitudinal cohort with distinct
daily-life domains, natural timing, strict action receipts, consent controls,
and the Slice B pause/inspect/forget gates.
