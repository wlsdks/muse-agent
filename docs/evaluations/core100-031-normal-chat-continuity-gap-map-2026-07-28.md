---
title: Core100-031 normal-chat Personal Continuity gap map
status: verified-current
generatedAt: 2026-07-28T16:05:07Z
head: 28e02e834648263664eac4131734320dbb2dad6b
inputManifestSha256: 65ee213788831aba3e4890fb8ed48c660f6663344e0fde242035289ddecc1d3f
scope: select/create, exact link, Pack preview, explicit open, explicit outcome
---

# Core100-031 normal-chat Personal Continuity gap map

## Verdict

Personal Continuity is not missing as a domain or store. Its exact-source core and
CLI/API/Web adapters already exist. The missing delta is the **normal agent-chat tool
adapter**: the runtime tool registry exposes no Continuity or Attunement tool for selecting
a thread, linking an exact source, previewing or opening a Pack, or recording an outcome.

This is a source-reconciliation result, not a release claim. It does not authorize
auto-linking, inferred outcomes, proactive delivery, or Slice B.

## Provenance

The input-manifest digest is the SHA-256 of the ordered per-file SHA-256 manifest for:

- `docs/strategy/attunement.md`
- `docs/goals/attunement-implementation-plan.md`
- `packages/attunement/src/attunement-store.ts`
- `packages/attunement/src/continuity-pack.ts`
- `packages/attunement/src/continuity-preparation.ts`
- `apps/api/src/attunement-routes.ts`
- `apps/cli/src/commands-attunement.ts`
- `apps/web/src/views/ContinuityReview.tsx`
- `packages/autoconfigure/src/loopback-tools.ts`
- `packages/autoconfigure/src/runtime-tool-registry.ts`

CodeGraph was healthy at generation time: 3,823 indexed files, 45,757 symbols, 115,736
edges, and no pending-file warning.

## Surface map

| Operation | Current domain contract | Existing owner surface | Mutation / authority | Normal-chat status |
| --- | --- | --- | --- | --- |
| select existing thread | `readAttunementState` returns exact `PersonalThread` IDs; `inspectThread` reads one exact thread | CLI `thread list` and interactive `muse continue`; authenticated `GET /api/attunement/threads`; Web Home/Continuity Review picker | Read-only. Selection alone creates no thread, link, delivery, or outcome. | **missing** — no agent-callable thread list/select tool |
| create thread | `createPersonalThread` requires an explicit `life\|work` kind and title | CLI `thread start --kind`; authenticated `POST /api/attunement/threads`; Web explicit form | Persistent thread creation. Kind has no default. | **missing** — no chat draft/confirm seam; direct model creation must remain forbidden |
| link exact source | `linkArtifact` plus exact type-specific validators; Work uses `linkWorkContinuity` | CLI `thread link`; authenticated `POST /api/attunement/threads/:threadId/links`; Web `LinkForm` | Persistent exact link. Only a local task may be `next-step`; other supported sources are context-only as declared. | **missing** — no chat preview/confirm tool and no exact task/note adapter |
| preview Pack | `prepareContinuityPack` and file-backed `readPreparedContinuityPack` resolve only linked exact evidence without opening a delivery | CLI `thread review` calls the pure preparation path; authenticated `GET /api/attunement/review` exposes the canonical review queue | Read-only. Must not allocate delivery/run IDs or write outcomes. | **missing** — no per-thread chat preview tool |
| explicitly open Pack | `openProductionAuthorizedContinuityPack` wraps `openPreparedContinuityPack` through the host-only provenance seam | CLI `muse continue`; authenticated `POST /api/attunement/threads/:threadId/continue`; Web Home/Continuity Review “Open Pack” | Persistent exactly-one delivery receipt on explicit open. Preview is not open and open is not helpfulness. | **missing** — no chat open tool or exact open approval/confirmation seam |
| explicit outcome | `recordProductionAuthorizedContinuityOutcome` wraps `recordContinuityOutcome`; accepted values are `used\|adjusted\|ignored\|rejected` | CLI `thread outcome`; authenticated `POST /api/attunement/deliveries/:deliveryId/outcome`; Web confirmation UI | Persistent immutable owner feedback and bounded display-policy reduction. Tool/task receipts and assistant sentiment are not outcomes. | **missing** — no chat outcome schema or owner-confirmed invocation |

## Main-chat registry evidence

`LoopbackToolsBundle` currently contains notes, calendar, tasks, messaging, reminders,
proactivity, followups, episodes, patterns, history, status, web-read, math, and search
groups. It has no dedicated Continuity or Attunement group.

`buildRuntimeToolRegistry` registers those groups plus runner, skill, knowledge/history,
home/email, time, memory, objective, action, background, feed, browsing, agenda, and brief
tools. It registers no dedicated thread select/create, link, Pack preview/open, or outcome
tool creator. A literal scan of the runtime registry and loopback assembly found no
`muse.continuity` or `muse.thread` tool definition.

The ordinary tasks loopback does already call the Attunement host seam to prepare/retry
factual task-completion interaction receipts. That narrow evidence callback is reused
substrate, not a thread-selection, linking, Pack, or outcome tool; a factual task receipt
still cannot become owner feedback.

The authenticated Attunement HTTP routes and the Web Continuity views are separate product
surfaces. Their existence must not be reported as normal-chat tool availability.

## Missing delta for Core100-032

The smallest safe first chat seam is one read-only tool schema that lists bounded existing
threads for explicit selection:

`muse.continuity.threads.list`

Its executor should reuse `readAttunementState` and project only canonical `id`, `kind`, and
bounded `title`. The schema should have no create/link/open/outcome fields. It must state
that listing or selecting grants no mutation or later authority.

This ordering is deliberate:

1. expose exact existing IDs without mutation;
2. separate suggestion from explicit create/bind confirmation in Core100-033;
3. add exact task-or-note link preview in Core100-034;
4. separate Pack preview from explicit open in Core100-035;
5. add the four-value explicit outcome seam in Core100-036.

## Explicit exclusions

- No topic-to-thread auto-linking.
- No default `life` or `work` inference.
- No fuzzy title match or ambiguous ID resolution.
- No preview-created delivery receipt.
- No open-created outcome.
- No task completion, factual receipt, timeout, sentiment, or assistant claim promoted to
  feedback.
- No proactive timing, Observe promotion, permission expansion, or external effect.
