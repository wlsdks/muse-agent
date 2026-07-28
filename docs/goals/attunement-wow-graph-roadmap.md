---
title: Attunement wow + graph roadmap
audience: [product, engineering, agents]
purpose: Run the signature Muse experience and Attunement Graph as a separate long-lived program
status: active
updated: 2026-07-29
related: [../strategy/attunement.md, ../design/attunement-graph.md, attunement-implementation-plan.md]
---

# Attunement wow + graph roadmap

This program is deliberately separate from the personal-agent core 100/300-task programs.
Those programs harden the general agent substrate. This one builds Muse's signature:

> **A procedural skill teaches an agent how to do a task better. An Attunement Policy
> teaches Muse how to collaborate with this person better.**

The two workstreams are inseparable:

- **Experience:** Shadow Muse → Continuity Capsule → Policy Card.
- **Engine:** a modular Attunement Graph that can connect intent, change, time, evidence,
  policy, and authority without copying existing stores.

## Program boundary

This roadmap consumes current memory, tasks, calendar, contacts, Continuity, timing,
receipt, trace, browser, and policy seams. It does not rebuild them or claim their existing
tests prove this program. A task that duplicates an active core-roadmap contract is marked
`superseded` here and left to the core program.

Only one source-changing graph BUILD slice may be active at a time. Research, benchmark
preparation, and organic evidence monitoring may run beside it when they do not mutate the
same source.

## Definition of done

The program is not done when Muse has a graph database. It is done when:

1. a real unfinished thread can be resumed with a grounded Capsule that identifies the
   stopping point, changes, evidence, next step, prepared action, and expected time;
2. Muse can explain why it surfaced or stayed silent and show a bounded counterfactual;
3. a Policy Card proposes a scoped collaboration change with evidence and reversible
   controls;
4. the user can inspect, correct, reject, roll back, and forget every learned relation;
5. controlled baselines and repeated dogfood show the graph path improves temporal,
   relational, or reconstruction outcomes enough to justify its cost;
6. every claim remains traceable to exact source evidence and no graph inference expands
   action authority.

## Execution order

| ID | Slice | Exit gate | Status |
|---|---|---|---|
| **AWG-001** | Product signature and research contract | Canonical wow scenario, honest shipped/roadmap boundary, research-backed graph design, and docs cross-links | completed |
| **AWG-010** | Reference graph kernel | `@muse/attunement-graph` domain types, invariants, append log, compact in-memory indexes, Activation Subgraph compiler, and conformance tests; no LLM or production DB | pending |
| **AWG-020** | Exact Continuity projection | Rebuildable projection of thread, artifact links, delivery, outcome, policy version, and source provenance without duplicated authority | pending |
| **AWG-030** | Explained change query | “What changed since I stopped?” returns exact temporal paths or abstains; flat/vector/graph baseline recorded | pending |
| **AWG-040** | Continuity Capsule v1 | User-invoked Capsule renders stopping point, changes, next step, prepared work, expected time, and source drawer | pending |
| **AWG-050** | Shadow Muse ledger | Records `silent|digest|offer`, reason, evidence, bounded alternatives, and later return timing without sending or acting | pending |
| **AWG-060** | Policy Card v1 | Evidence counts, scope, proposed delta, trial/edit/reject/rollback; no hidden promotion | pending |
| **AWG-070** | Storage bake-off | Reference adapter vs PostgreSQL vs at most one embedded graph candidate on correctness, cost, recovery, portability, and maintenance | pending |
| **AWG-080** | Durable local graph adapter | Selected adapter passes conformance, export/rebuild, corruption, migration, forget, and crash-recovery gates | pending |
| **AWG-090** | Dogfood qualification | Controlled scenarios plus repeated organic use; reconstruction-cost and policy-correction evidence remain separately reported | pending |

Raw numbering does not activate work. Before each BUILD slice, inspect current source and
classify it as `missing`, `partial`, `built-unverified`, `verified-current`, `monitoring`,
`blocked`, `deferred`, `rejected`, or `superseded`. Implement only the missing delta.

## Architecture gates

Every source-changing slice must preserve:

- domain semantics independent of a database SDK;
- authoritative existing stores plus rebuildable graph projection;
- append-oriented, versioned, provenance-bearing assertions;
- bi-temporal validity and transaction time;
- explicit epistemic class;
- bounded traversal and fail-closed source resolution;
- deterministic projection where deterministic evidence exists;
- LLM extraction isolated behind a replaceable port and never treated as authority;
- portable export, migration, forget cascade, and rollback;
- provider-neutral core and local-first default.

## Dogfood loop

Each meaningful vertical slice follows:

```text
product-shaped scenario
  → flat/vector baseline
  → graph implementation
  → deterministic grader + adversarial faults
  → local dogfood
  → independent completion evaluation
  → commit, sync main, merge, push
  → evidence-backed next activation
```

The first canonical scenario is the interrupted trip:

- three lodging candidates were being compared;
- the flight changed afterward;
- one cancellation deadline is tomorrow;
- an 18-minute gap is available;
- prior evidence suggests short gaps fit a change-only comparison;
- the user can see why now, sources, changes, execution boundary, and suppression control.

The grader must also test the opposite outcome: if timing evidence is weak, the correct
graph-assisted decision is silence.

## Research and open-source policy

Before selecting algorithms or storage:

1. read primary papers and standards;
2. inspect current open-source code and licenses;
3. record the exact version/commit used;
4. reproduce relevant claims when practical;
5. include a negative or simpler baseline;
6. document failures, contradictions, and unresolved gaps;
7. adapt mechanisms, not proprietary code or vendor claims.

Current starting references and limitations are recorded in
[the graph design](../design/attunement-graph.md). Research is refreshed at storage
selection and qualification gates because projects, APIs, and benchmark results drift.

## Continuous integration with `main`

This dedicated worktree remains a long-lived program branch, not a forked product:

1. fetch and incorporate `origin/main` before activating a slice;
2. keep BUILD WIP at one and resolve overlap with the core roadmap before editing;
3. run the slice-specific checks and a fresh-context independent evaluation;
4. commit product-behavior boundaries, not every checkbox;
5. fetch/rebase once more, merge the verified slice into local `main`, and push normally;
6. fast-forward this worktree to the resulting `main` merge before the next slice.

No force push, moving tag, bypassed hook, alternate refspec, or silent conflict resolution
is authorized.
