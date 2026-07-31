---
title: Muse Attunement — product contract
audience: [product, design, engineering, agents]
purpose: Define Muse's product wedge without claiming roadmap capabilities are shipped
status: north-star
updated: 2026-07-30
related: [../design/attunement/README.md, ../design/attunement/attunegraph.md, ../../internal/goals/attunement-implementation-plan.md, ../../internal/goals/attunegraph-roadmap.md, ../trust/privacy-and-data.md]
---

# Muse Attunement

> **Product goal: Muse learns how one person lives and works, and gets better at when and how to help.**

Attunement is Muse's product direction. It is not a claim that the complete loop is
already shipped. Muse already has personal memory, pattern primitives, interruption
controls, grounded recall, and guarded browser actions. The closed loop that connects
personal context, outcomes, and better-timed help is the work ahead.

Muse spans one person's daily life and work. In plain language, Attunement means **learning
how to fit help into one person's life**. It is not another word for memory, personality,
productivity tracking, or sending more notifications.

The target operating mode is consented, user-controlled, 24-hour personal continuity over
approved sources. Muse should continuously retain the event and relationship structure
needed to resume life and work, while pause, source scope, retention, export, and physical
forget remain visible owner controls. Storage and processing placement must be explicit:
local files, self-hosted services, and selected cloud providers are deployment choices,
not Muse's identity. This does not mean recording every screen byte or silently shipping
personal activity to an external service.

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

## The signature Muse moment

The target experience is not a generic reminder. Imagine that the user stopped while
planning a trip:

> “Last time, you stopped while comparing three lodging options. Since then, your flight
> time changed, and one saved property's cancellation deadline is tomorrow. You have an
> 18-minute gap now, and in similar short gaps you previously preferred a change-only
> comparison. Shall I summarize only what changed and put one option on hold?”

The surface also shows:

- why Muse chose this moment;
- which exact sources it connected;
- what changed since the user stopped;
- how far the proposed action would go before another confirmation;
- “do not show this at this timing again.”

If the user chooses “not now—this evening,” Muse does not quietly turn that into a global
preference. It proposes a visible, scoped policy:

> “For this thread, should I suggest life planning during your evening review rather than
> between work blocks?”

This is built from three product mechanisms:

1. **Shadow Muse** learns first without interrupting or acting. It records candidate offers,
   reasons for silence, bounded counterfactual timing, the user's actual return, and the
   reconstruction work a prepared Capsule might have saved.
2. **Continuity Capsule** is the product form of a richer Continuity Pack: the exact stopping
   point, changes since then, needed sources, one next step, a prepared draft/action, and
   expected time.
3. **Policy Card** makes learning inspectable: the proposed collaboration rule, evidence,
   scope, and controls to trial, edit, reject, or roll back it.

> **Muse does not remember apps; it remembers the state you intended to continue.**
>
> **Muse doesn't remember apps. It remembers the state you meant to continue.**

A procedural skill teaches an agent how to do a task better. An Attunement Policy teaches
Muse how to collaborate with this person better.

The complete three-part experience remains target architecture rather than a shipped wow claim.
Its underlying [AttuneGraph](../design/attunement/attunegraph.md) now has bounded
library/runtime substrates, including the worker-isolated durable projection journal, an explicit
opt-in Continuity projection writer, a claim-safe read-only Policy Card compiler/tool, and a
content-addressed factual return receipt emitted after an explicit CLI Pack open. The return
receipt records only a temporal association with a prior Shadow timing candidate; it does not
infer feedback, outcome, usefulness, causality, reconstruction benefit, or permission. With the
explicit database opt-in, a separately versioned full projection now makes that fact durable and
queryable as `Decision PRECEDED Delivery` plus `Evidence OBSERVED_DURING Thread`, without changing
the receipt's authority. An authenticated read-only Continuity card can now show the exact
persisted receipt and whether a complete bounded Working Graph contains that active pair; partial
reads remain visibly incomplete, and the card does not infer that the Pack helped. AttuneGraph
does not yet have the complete Source Adapter, automatic
Policy Card surface and controls, maintenance, qualification, or product-composition program.
Dependency-ordered work lives in the
[wow + graph roadmap](../../internal/goals/attunegraph-roadmap.md).

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
5. **Observation stays controllable.** Observe is data-minimized, visible, pausable,
   inspectable, and forgettable. Sensitive sources and any external processing are opt-in.

## Provider and deployment contract

Muse is provider-neutral and deployment-flexible. The core reasoning, approval, evidence,
and adaptation contracts do not depend on a particular model vendor, storage vendor, or
execution location. Provider-specific behavior stays behind adapters.

- Local file stores and Ollama remain fully supported deployment choices.
- Supported cloud and self-hosted model or execution providers are first-class choices when the
  owner configures them.
- `MUSE_LOCAL_ONLY=true` remains a strict opt-in privacy posture that fails closed before
  prohibited egress; it is a safety feature, not the product tagline.
- Every external data path must state what leaves the device, which provider receives it,
  and which owner control disables or revokes it.
- Multi-device sync and hosted personal storage are not shipped claims until their
  encryption, identity, conflict, deletion, export, and recovery contracts pass a gate.

## Current, experimental, roadmap

| Status | What it means in Muse today |
|---|---|
| **Available now** | Provider-neutral runtime; local personal stores; user memory; grounded recall; guarded browser control; traces/checkpoints; Personal Continuity Slice A; and Observe O1: explicit consent for one exact thread, category/time/duration-only local sessions, inspect/pause/resume/forget, and one fenced app-only collector. O1 performs no hypothesis, policy, delivery, model call, send, or action. Packs remain user-invoked with four explicit outcomes and a narrow display-policy update. After an explicit `muse continue` or `muse thread continue` successfully opens a Pack, Muse can persist a bounded factual return receipt against the latest strictly prior rule-v3 timing candidate; unmatched/ambiguous/write-failed states are visible, and the receipt is neither feedback nor a usefulness/causality claim. With `MUSE_ATTUNEGRAPH_DATABASE`, the same path rebuilds a complete reserved-scope graph with only the exact temporal/thread return relations; graph failure is visible and non-fatal to the Pack/receipt, and a later full rebuild removes forgotten relations from the active head. The authenticated Continuity screen can inspect at most 20 exact receipts, their decision-to-explicit-CLI-open interval and authority denials, plus `linked | not-linked | incomplete | unavailable | not-configured` graph status; it does not record a return, write/repair the graph, or claim success or usefulness. Explicit Pack Preview also dogfoods a bounded process-local AttuneGraph baseline and returns semantic resume comparison facts. Legacy caller-declared Capsule render data remains compatible. A separate assembly-scoped `muse.continuity.capsule.prepare` path can make one bounded configured-provider call only after an exact compared result and require every model claim to cite exact available current task/note/reminder source keys. The empty Chat session now offers an explicit Prepare action over the same service: render performs no model call, the first request may truthfully seed only a process-local baseline, and a later ready result is reduced to a `private, no-store` display card containing the recorded/current next steps, verified relation changes, estimated display-only draft, and visible source/authority caveats. Configured auth denies anonymous API calls, but this still proves citation-key membership rather than semantic entailment, authenticated source observation, freshness, durability, usefulness, or current-world truth. An explicit read-only Policy Card preview can compile one current learning opportunity from one fresh local snapshot while separating authoritative experience, caller-supplied replay claims, and locally derived graph explanation; it performs no mutation or action. |
| **Experimental substrates** | Pattern suggestions, proactive surfacing, background review, and self-followup. They contribute signals or delivery paths, but are not an Attunement loop. |
| **Roadmap** | Automatic Shadow Muse timing/return detection, automatic stop capture and automatic/timing-aware Continuity Capsule surfacing beyond the explicit API/UI, authenticated evidence witness, durable cross-process comparison baseline, Capsule preparation across calendar/contact/run/checkpoint/browsing/conversation/work/resource sources, semantic entailment qualification, automatic Policy Card surfacing plus trusted trial/edit/reject/apply/rollback controls, default/continuous AttuneGraph ingestion and current-world storage, physical graph-journal forget/compaction, Observe hypothesis/correction controls, Personal Rhythm Model, Friction Discovery, usefulness qualification, and timing-aware help. The current process-local resume baseline, explicit CLI return source ledger/card, opt-in durable return projection, explicit Capsule card, and inert Policy Card preview do not themselves provide proactive timing, usefulness evidence, or current-world truth. Exact browsing context and O1 category collection do not themselves ship proactive timing. |

## What Continuity, Muse Work, and Observe mean

- **Muse Observe** currently provides O1 consent and collection evidence: see category-only
  sessions, pause/resume, inspect, and forget them. Hypothesis inspection/correction is roadmap.
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
[implementation plan](../../internal/goals/attunement-implementation-plan.md).
