---
title: Muse Attunement — product contract
audience: [product, design, engineering, agents]
purpose: Define Muse's product wedge without claiming roadmap capabilities are shipped
status: north-star
updated: 2026-07-13
related: [../design/attunement.md, ../goals/attunement-implementation-plan.md, ../privacy-and-data.md]
---

# Muse Attunement

> **Product goal: Muse learns how you live and work, then gets better at knowing when and how to help.**
>
> **제품 목표: Muse는 한 사람의 삶과 일을 배우고, 언제 어떻게 도울지 점점 더 잘 맞춥니다.**

Attunement is Muse's product direction. It is not a claim that the complete loop is
already shipped. Muse already has personal memory, pattern primitives, interruption
controls, grounded recall, and guarded browser actions. The closed loop that connects
personal context, outcomes, and better-timed help is the work ahead.

Muse spans one person's daily life and work. In plain language, Attunement means **learning
how to fit help into one person's life**. It is not another word for memory, personality,
productivity tracking, or sending more notifications.

## The user need

People do not mainly want an agent that knows more facts about them. They want to carry less
mental residue without giving up authorship: fewer forgotten promises, fewer restarts,
fewer repeated searches, fewer interruptions at the wrong moment, and less time rebuilding
the context of something they meant to continue.

The first memorable moment is **Personal Continuity**:

> You choose an unfinished thread—a project, trip, appointment, person to contact, or article
> to finish. Muse gathers only the items you linked to it, shows where it stands and one safe
> next step, then learns from whether you used, adjusted, ignored, or rejected the help.
> Automatic
> detection comes later.

This is more specific than memory, personalization, or proactivity:

- **Memory** retains facts and prior context.
- **Personalization** changes content or tone from stated preferences.
- **Proactivity** initiates without a new prompt.
- **Attunement** learns the collaboration policy: when to stay quiet, when to surface,
  what form of help fits, how far to act, and whether the intervention helped the person's
  life or work.

## The compounding loop

```text
chosen personal thread → Continuity Pack → outcome → adaptation → next help

optional Observe → rhythm evidence → friction candidate → better timing ────┘
```

1. **Personal thread:** the user chooses something unfinished in daily life or work and
   explicitly links the items that belong to it.
2. **Continuity Pack:** restore its grounded context and prepare one safe next step.
3. **Outcome:** record whether the pack was used, adjusted, ignored, or rejected. Opening
   a pack is a separate delivery event, not proof that it helped.
4. **Adaptation:** change the next pack's timing, form, confidence threshold, or silence—not
   the user's goals—using that outcome.
5. **Optional Observe:** collect the minimum consented activity metadata needed to see
   transitions and stable blocks—not raw keystrokes or continuous screen recordings.
6. **Personal Rhythm Model:** form inspectable, evidence-linked hypotheses about focus,
   transitions, repeated routes, and resumption patterns.
7. **Friction Discovery:** find recurring loss of momentum. Never label exploration as
   “stuck” without evidence and user confirmation.

The compounding asset is not a larger prompt. It is a personal, inspectable history of
which collaboration policy works in which moment.

Development starts with a user-invoked **Continuity Pack** that closes personal thread → help
→ outcome → next-help in one thin path. Observe and rhythm inference are later slices that
improve its timing; they are not prerequisites for testing whether the pack is useful.

## Product principles

1. **Learn the life, not only the profile.** Stated preferences remain valuable, but
   recurring routines, unfinished threads, corrections, and intervention outcomes are the
   differentiating signal.
2. **Preserve momentum.** A useful Muse often does less: it withholds interruption,
   prepares context in the background, and appears at a natural boundary.
3. **Show the evidence.** Every rhythm or friction hypothesis must say what observations
   support it. “You seem stuck” without evidence is forbidden.
4. **The user keeps authorship.** Muse removes mechanical friction; consequential choices
   stay with the user. Third-party sends remain draft-first and fail-close.
5. **Observation stays controllable.** Observe is local-first, visible, pausable,
   inspectable, and forgettable. Sensitive sources are opt-in.

## Current, experimental, roadmap

| Status | What it means in Muse today |
|---|---|
| **Available now** | Provider-neutral runtime; local personal stores; user memory; grounded recall; guarded browser control; traces/checkpoints; and Personal Continuity Slice A: user-created `life`/`work` threads, exact local task/note links plus context-only reminder links, a user-invoked pack, four explicit outcomes, and a narrow display-policy update. |
| **Experimental substrates** | Pattern suggestions, proactive surfacing, background review, and self-followup. They contribute signals or delivery paths, but are not an Attunement loop. |
| **Roadmap** | More Continuity source adapters, opt-in Observe controls, persisted observation sessions, Personal Rhythm Model, Friction Discovery, and timing-aware help. |

## What Continuity, Muse Work, and Observe mean

- **Muse Observe** is the consent and evidence surface: see what is collected, pause it,
  inspect hypotheses, correct them, and forget events or sources.
- **Personal Continuity** is the general assistance surface for daily life and work: return
  to a chosen unfinished thread with its linked context and one safe next step.
- **Muse Work** is the assistance surface: hold interruptions during focus, prepare a
  work-specific continuity pack at a boundary, and perform only grounded, approved browser
  or Muse-local actions.

Neither is a promise of arbitrary desktop autonomy. Near-term computer use is deliberately
limited to the browser and Muse-owned artifacts, where targets can be observed and actions
can fail closed.

### Evidence provenance trust boundary

Continuity readiness distinguishes production-authorized evidence from controlled and
unclassified records. The ordinary `@muse/attunement` package surface cannot mint or
perform production-authorized writes. Muse's CLI, authenticated local API, and production
loopback assembly use the explicit `@muse/attunement/host` seam, whose imports are checked
against a small repository allowlist. This prevents accidental evidence laundering by
ordinary package consumers; it is not a security boundary against malicious same-process
code that deliberately imports the host seam, reads private workspace files, or edits the
owner's local JSON. Defending that stronger threat requires a separately managed key/MAC
or process boundary and is not a shipped claim.

## Success and failure

Attunement succeeds only when people carry less context in their heads and its help becomes
more useful over time. More observations, more notifications, and more agent actions are
not success metrics. The dependency-ordered delivery gates and kill criteria live in the
[implementation plan](../goals/attunement-implementation-plan.md).
