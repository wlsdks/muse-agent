---
title: Attunement Graph Engine — agent-native temporal provenance graph
audience: [engineering, product, security, agents]
purpose: Define the modular graph engine that powers Muse's signature Attunement experience
status: proposed
updated: 2026-07-29
related: [../strategy/attunement.md, attunement.md, ../goals/attunement-wow-graph-roadmap.md]
---

# Attunement Graph Engine

> **Product thesis:** Muse should not merely use a graph database. Muse should own an
> agent-native graph that can explain how one person's intent, unfinished work, changing
> circumstances, evidence, collaboration policy, and action authority relate over time.

The target is a dedicated, maintainable `@muse/attunement-graph` module. It is not a generic
knowledge graph product and it is not a new source of truth for tasks, notes, calendar,
memory, or Attunement receipts. Those stores remain authoritative. The graph is a
rebuildable, append-oriented projection that makes relationships and changes queryable.

The engine exists to power three product experiences:

1. **Shadow Muse** can record why it would speak or stay quiet, and compare that decision
   with what the user later did.
2. **Continuity Capsule** can reconstruct the exact stopping point, what changed afterward,
   the relevant evidence, one next step, prepared work, and expected time.
3. **Policy Card** can show what Muse proposes to learn about collaborating with this person,
   the evidence behind it, its scope, and how to try, edit, reject, or roll it back.

The full experience and this engine are roadmap work. Existing graph-like data is a
substrate, not proof that the engine or experience has shipped.

## Why a graph, and where it must beat flat or vector memory

Vector retrieval is useful for “find things similar to this text.” It is not enough for
questions whose answer depends on exact identity, paths, changing validity, or scoped policy:

- Which exact trip thread was this task linked to, by whom, and when?
- What changed after the user stopped, and which source proves each change?
- Did a short transition window precede a used Capsule, or was it merely nearby in time?
- Which policy version produced this offer, what outcomes supported it, and where does the
  proposed change apply?
- If one source is forgotten, which derived claims, Capsules, and Policy Cards become invalid?

Attunement Graph earns its complexity only when it improves these queries over a flat and
vector baseline. “We use Cypher” or “we have connected nodes” is not a product outcome.

## Research snapshot and lessons

This design reviewed primary papers, standards, current official documentation, and current
open-source source trees on 2026-07-29.

Open-source source snapshot:

- Graphiti `00b0130bab4544574deb4ea8b1d30ceb82de9c5c` (Apache-2.0);
- Mem0 `b357a5a1b03c299ec8229c268e63cfac0f7c6566` (Apache-2.0);
- LadybugDB `a10cecbc76e05f993af6c6f4a57edbbf438bb376` (MIT).

| Reference | Useful mechanism | What Muse should not copy blindly |
|---|---|---|
| [Microsoft GraphRAG](https://www.microsoft.com/en-us/research/project/graphrag/) | Entity/community structure and global-versus-local retrieval over private corpora | It is primarily batch document understanding; Muse's core problem is a changing single-person world and collaboration policy. |
| [Zep / Graphiti paper](https://arxiv.org/html/2501.13956v1) | Episode → entity/fact → community tiers; source lineage; bi-temporal validity; hybrid semantic, keyword, and traversal retrieval | The paper is vendor-authored, some benchmark gains are marginal or category-dependent, and LLM contradiction resolution cannot become Muse's authority. |
| [Graphiti OSS](https://github.com/getzep/graphiti) | Incremental temporal context graph and a graph-driver interface | Provider-specific queries still leak into domain objects; extraction relies heavily on structured LLM output; current Kùzu support is deprecated. |
| [Independent 2026 LTM comparison](https://arxiv.org/html/2601.07978) | Reproducible cost, resource, retrieval, and accuracy accounting across vector/graph/hybrid systems | Its LoCoMo/cloud-edge setup is not Muse dogfood. It nevertheless falsifies “graph is automatically better”: Graphiti under-retrieved in that setup. |
| [Mem0 OSS v2→v3 migration](https://github.com/mem0ai/mem0/blob/main/docs/migration/oss-v2-to-v3.mdx) | Multi-signal retrieval and simpler built-in entity linking | Mem0 removed roughly 4,000 lines of external graph-store paths. Backend breadth can become maintenance weight without product proof. |
| [LadybugDB](https://github.com/LadybugDB/ladybug) | Embedded/serverless property graph, Node binding, full-text/vector indexes, WAL, ACID transactions, and no required daemon | It is a young community successor to Kùzu, which was archived in October 2025. It is a bake-off candidate, not an architectural dependency. |
| [W3C PROV-O](https://www.w3.org/TR/prov-o/) | Explicit generation, derivation, attribution, primary-source, revision, and invalidation relations | Muse should adopt the semantics it needs, not introduce RDF/OWL as a runtime requirement. |

The strongest common pattern is not “put embeddings in a graph DB.” It is:

```text
immutable source episode/evidence
  → typed, provenance-bearing assertion
  → temporal validity and supersession
  → hybrid candidate retrieval
  → bounded graph traversal
  → explanation that resolves back to exact sources
```

## Muse-specific invention: a personal context compiler

The most useful graph is not the largest graph. On every relevant turn, Attunement Graph
should compile a tiny **Activation Subgraph** containing only:

- the active thread and exact stopping point;
- facts that changed after that point;
- evidence paths needed to justify those changes;
- the policy version and scope governing whether/how to help;
- the action-authority boundary;
- unresolved contradictions and missing evidence.

The agent receives this bounded slice, not arbitrary access to the whole personal graph.
That changes the graph from passive memory into a runtime context compiler:

```text
turn + active thread + time
  → exact seed set
  → temporal/provenance traversal
  → uncertainty and authority filter
  → token-budgeted Activation Subgraph
  → model phrasing or deterministic UI
```

This creates four agent-native advantages:

1. **Attention efficiency:** only the relationships needed for this decision consume model
   context.
2. **Decision consistency:** CLI, API, web, scheduler, and future voice use the same
   compiled evidence/policy slice.
3. **Safe abstention:** missing provenance or contradictory paths remain explicit instead
   of being flattened into confident prose.
4. **Inspectable reasoning input:** traces can show the exact graph slice the agent saw
   without exposing the entire personal store.

### Two logical graph layers

The engine should expose two logical layers even if one physical store backs both:

- **Evidence Graph:** durable, append-oriented, source-addressed facts, receipts, validity,
  supersession, and derivation. This layer is rebuildable and auditable.
- **Working Graph:** short-lived activation, candidate paths, counterfactual alternatives,
  ranking features, and token budgets for one decision. It expires and grants no authority.

Shadow Muse writes durable decision receipts only after a Working Graph decision is made.
Discarded search paths and chain-of-thought are not persisted.

### Silence is first-class

Most agent databases store what was said or done. Attunement also needs bounded records of
why Muse stayed quiet. A `Decision(silent)` linked to its evidence, policy, and expiry lets
Muse evaluate timing without increasing interruptions. The record stores the deterministic
decision inputs and selected reason code, not private model reasoning.

## Non-negotiable semantic model

### Nodes

The first ontology is deliberately small:

- `Thread` — an explicit life or work intention owned by the user.
- `Artifact` — an exact task, note, reminder, calendar occurrence, contact, run,
  checkpoint, browsing visit, conversation, or Work reference.
- `Evidence` — an immutable source snapshot, observation, or receipt.
- `Delivery` — one surfaced Capsule or offer.
- `Outcome` — `used | adjusted | ignored | rejected`; never inferred from an open.
- `Policy` — one versioned collaboration rule with explicit scope.
- `Decision` — a Shadow Muse `silent | digest | offer` decision and its alternatives.
- `Action` — a performed or refused effect with its existing approval/action receipt.

Contacts, tasks, calendar items, and memories stay owned by their current packages. A graph
node holds only a canonical reference plus bounded projection data needed for a query.

### Edges

Edges are closed enums, not free-form LLM prose:

- `LINKED_TO`, `NEXT_STEP_FOR`, `CONTEXT_FOR`
- `SUPPORTED_BY`, `DERIVED_FROM`, `REVISION_OF`, `SUPERSEDES`
- `OBSERVED_DURING`, `DELIVERED_FOR`, `PRODUCED_OUTCOME`
- `PROPOSES_POLICY`, `SCOPED_TO`, `GOVERNED_BY`
- `PRECEDED`, `CORRELATES_WITH`, `AUTHORIZED_BY`, `PERFORMED`

`CAUSED` is absent from the initial ontology. Timing proximity or task completion is not
causality. A future causal edge requires a separately reviewed causal contract and evidence
stronger than correlation.

### Epistemic class

Every assertion carries exactly one class:

- `user-asserted`
- `source-observed`
- `deterministic-derived`
- `model-hypothesis`

The class never silently upgrades. A model hypothesis cannot grant permission, become a
user outcome, or overwrite an observed fact. Acceptance or correction creates a new
assertion and preserves the prior one.

### Bi-temporal time

Every assertion separates:

- `validFrom` / `validTo`: when the claim held in the user's world;
- `recordedAt` / `supersededAt`: when Muse learned or replaced it.

This lets Muse answer both “what is true now?” and “what did Muse believe when it offered
this?” without rewriting history.

### Provenance and derivation

Every derived node or edge must resolve to immutable source IDs and the deterministic rule
or model invocation that produced it. The minimum envelope is:

```ts
interface GraphAssertion {
  id: string;
  subject: GraphRef;
  predicate: GraphPredicate;
  object: GraphRef;
  epistemicClass:
    | "user-asserted"
    | "source-observed"
    | "deterministic-derived"
    | "model-hypothesis";
  sourceRefs: readonly EvidenceRef[];
  validFrom?: string;
  validTo?: string;
  recordedAt: string;
  supersededAt?: string;
  derivation: {
    kind: "projection" | "rule" | "model";
    version: string;
    runId?: string;
  };
}
```

The production type may evolve, but exact source references, temporal separation,
epistemic class, and derivation version are mandatory.

## Module architecture

```text
existing authoritative Muse stores
  └─ projection source ports
      └─ assertion journal + deterministic projector
          └─ graph kernel
              ├─ store port
              │   ├─ in-memory reference adapter
              │   ├─ durable local adapter candidate
              │   └─ optional PostgreSQL adapter
              └─ query + explanation service
                  ├─ Shadow Muse
                  ├─ Continuity Capsule
                  └─ Policy Card
```

### `@muse/attunement-graph` owns

- node/edge/assertion types and schema versions;
- graph invariants and deterministic projection rules;
- query plans expressed in a storage-neutral intermediate form;
- explanation paths and source-resolution requirements;
- rebuild, verify, forget, migration, and compatibility contracts;
- a reference in-memory adapter used by conformance tests.

### It does not own

- authoritative task, note, calendar, contact, memory, or Attunement state;
- LLM provider selection or prompts;
- UI rendering;
- action approval or execution;
- background scheduling;
- a specific graph database SDK in its public domain API.

### Ports

The public architecture should converge on small interfaces:

```ts
interface AttunementGraphProjector {
  project(batch: readonly SourceEnvelope[]): Promise<ProjectionReceipt>;
  rebuild(scope: GraphScope): Promise<RebuildReceipt>;
}

interface AttunementGraphQuery {
  changesSince(threadId: string, instant: string): Promise<ExplainedChangeSet>;
  resumptionContext(threadId: string, now: string): Promise<ExplainedSubgraph>;
  policyEvidence(scope: PolicyScope): Promise<ExplainedPolicyEvidence>;
  decisionCounterfactual(decisionId: string): Promise<ExplainedCounterfactual>;
}

interface AttunementGraphStore {
  append(assertions: readonly GraphAssertion[]): Promise<AppendReceipt>;
  traverse(query: GraphQueryPlan): Promise<GraphResult>;
  forget(scope: ForgetScope): Promise<ForgetReceipt>;
  verify(): Promise<GraphVerification>;
}
```

The graph module consumes explicit source envelopes. It must not import every personal
store and create a second composition root.

## Storage strategy

No production database is selected in this document.

1. Build an in-memory reference engine and backend conformance suite first.
2. Run the same dogfood corpus against a minimal append-only local implementation,
   PostgreSQL, and at most one embedded property-graph candidate.
3. Adopt an embedded engine only if it wins on the product queries, install size,
   startup/rebuild time, memory, crash recovery, migration, Node 22/24 and macOS/Windows
   support, maintenance health, and license.
4. Keep a portable assertion export so an abandoned backend can be replaced.

LadybugDB is the current embedded bake-off candidate because it is serverless, exposes a
Node package, and supports full-text/vector search plus ACID/WAL. Its young-fork risk means
Muse must be able to delete that adapter without changing domain or query contracts.

### Lightweight reference profile

Muse is single-user and local-first, so the first useful engine does not need a distributed
graph server or a general-purpose query language. The reference profile should use:

- an append-only assertion log with checksummed, atomic snapshots;
- typed integer/string IDs and compact adjacency/time indexes in memory;
- per-thread lazy materialization rather than loading unrelated life domains;
- delta projection from source receipts instead of re-extracting the world;
- a small set of compiled query recipes instead of model-generated Cypher;
- optional lexical/vector seed indexes, loaded only when a query needs them;
- periodic compaction that preserves source IDs, supersession, and exportability.

The intended hot path is exact/time filtering plus one or two bounded hops. Community
detection, arbitrary multi-hop exploration, and embeddings are opt-in tools for queries
that prove they need them, not baseline overhead.

An embedded third-party engine should replace only the storage adapter after it beats this
profile. If the reference engine already satisfies the single-user product workload, that
is a valid result: Muse can still own an agent-native graph database contract without
shipping a heavyweight daemon.

## Query discipline

The engine uses hybrid retrieval, but each stage has a distinct job:

1. exact IDs and filters establish user, thread, scope, time, and authority;
2. lexical/vector retrieval proposes seed evidence;
3. bounded traversal expands only allowlisted edge types and hop counts;
4. deterministic reranking prefers current, direct, strongly sourced paths;
5. the explanation builder rejects results whose source path cannot be resolved.

An LLM may phrase a returned explanation. It may not invent a traversal, issue arbitrary
database queries, rewrite provenance, or decide authority.

## Forget, rebuild, migration, and failure

- The graph is disposable: deleting it and replaying authoritative sources must reproduce
  the same deterministic projection.
- Source deletion triggers a derivation-aware invalidation cascade; unexplained orphan
  assertions fail verification.
- Journal writes are idempotent and content-addressable where practical.
- Schema migrations are forward-only, versioned, testable on fixtures, and exportable.
- Corrupt, future-version, partially written, or provenance-incomplete state fails closed.
- Projection lag is visible. Consumers receive `fresh | stale | unavailable`, never a
  plausible-looking stale answer.

## Dogfood and qualification

Muse will not qualify this engine with graph size or unit-test count. The initial dogfood
set uses real product-shaped but privacy-safe scenarios:

1. resume a trip after a flight change and a hotel cancellation deadline;
2. distinguish a current preference from a superseded one;
3. explain why an offer appeared now and which policy version governed it;
4. forget one source and prove every dependent claim disappears or becomes unavailable;
5. show that a task completion receipt is factual interaction evidence, not a `used` outcome;
6. refuse a cross-thread or cross-user traversal even when text is semantically similar.

Every scenario compares:

- flat exact lookup;
- current vector/keyword retrieval where applicable;
- Attunement Graph.

Required metrics include answer correctness, source-path precision, temporal correctness,
abstention, policy-scope correctness, p50/p95 latency, ingest/rebuild time, disk/RAM, model
calls/tokens, and migration/forget integrity. Graph wins only if it creates a meaningful
product improvement without unacceptable local cost.

Organic dogfood remains separate from controlled replay. A user-visible “wow” claim needs
repeated real resumptions where the Capsule reduces reconstruction work and the proposed
Policy Card is accepted or usefully corrected. Opens, synthetic trials, or graph traversal
success alone do not prove usefulness.

## Limitations and open questions

- Current research does not establish that graph memory is generally more accurate or
  cheaper than well-built flat/vector retrieval.
- Entity resolution and contradiction detection remain error-prone when delegated to an
  LLM, especially a small local model.
- The first Muse ontology may be sufficient without a specialized graph DB.
- Counterfactuals describe policy alternatives, not experimentally identified causal effects.
- LadybugDB's long-term maintenance and cross-platform Node behavior require direct bake-off
  evidence before adoption.

These are validation targets, not reasons to lower the ambition. “Best in class” here means
the engine survives these falsification tests while producing a collaboration experience
that a generic memory layer cannot.
