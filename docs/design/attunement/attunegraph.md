---
title: AttuneGraph — agent-native temporal provenance graph
audience: [engineering, product, security, agents]
purpose: Define the modular graph engine that powers Muse's signature Attunement experience
status: partial-implementation
updated: 2026-07-31
related: [../../strategy/attunement.md, README.md, agent-native-graph-core.md, ../../../internal/goals/attunegraph-roadmap.md]
---

# AttuneGraph

**AttuneGraph** is the canonical product and architecture name.
**AttuneGraph Engine** means the complete semantic/query/compiler layer; **AttuneGraph Store** means its
future built-in durable journal and indexes. A **receipt** is a verified immutable evidence
input projected into AttuneGraph—it is not another database.

> **Product thesis:** Muse should not merely use a graph database. Muse should own an
> agent-native graph that can explain how one person's intent, unfinished work, changing
> circumstances, evidence, collaboration policy, and action authority relate over time.

Its optimization target is the AI agent loop—not generic graph feature breadth: minimal
context assembly, bounded temporal/causal reasoning, explicit uncertainty, provenance,
permission-safe action boundaries, local incremental updates, and cheap rebuild/forget.

The architecture has two explicit packages: neutral engine `@attunegraph/core` and
Muse integration `@muse/attunegraph`. The engine is not a generic knowledge graph product
and it is not a new source of truth for tasks, notes, calendar, memory, or Attunement
receipts. Those stores remain authoritative. The graph is a rebuildable, append-oriented
projection that makes relationships and changes queryable.

AttuneGraph is now a standalone public open-source product at
[`wlsdks/attunegraph`](https://github.com/wlsdks/attunegraph). Muse pins that repository as the
same-path `packages/attunegraph` submodule and keeps product integration in
`@muse/attunegraph`; Muse is the first consumer, not an Engine dependency. The first clean-room
snapshot passed its independent TypeScript/Vitest configuration, Node 24.16 conformance suite,
non-Muse example, and packed-artifact inspection. Registry publication, Agent Bridge/MCP,
write/repair Admin, and the remaining engine roadmap are separate claims. The Module topology and
repository strategy are in
[ADR 0001](../../architecture/adr/0001-attunegraph-product-module-boundary.md).

Markdown is AttuneGraph's planned portable document interchange/export format. Obsidian is a
planned first-class local vault Adapter over Markdown, frontmatter, wiki links, and stable
file/block refs. Notion is a planned opt-in sync Adapter that preserves
workspace/page/block/database IDs as source refs. Muse already has local Markdown notes
and generic Notion provider substrates, but the AttuneGraph-specific round-trip/source Adapter
contracts are not shipped yet.
RAG may nominate semantically related items; AttuneGraph verifies their exact thread, time,
relationship, provenance, and policy scope. Document bodies remain authoritative in their
source rather than becoming a lossy graph-owned copy.

The engine exists to power three product experiences:

1. **Shadow Muse** can record why it would speak or stay quiet, and compare that decision
   with what the user later did.
2. **Continuity Capsule** can restore the state needed to continue: what changed afterward,
   relevant evidence, a next step, prepared work, and expected time. A future explicit
   stop-marker/capture contract is required before it can claim an exact stopping point;
   the current substrate resumes from the previous observation's recorded next step.
3. **Policy Card** can show what Muse proposes to learn about collaborating with this person,
   the evidence behind it, its scope, and how to try, edit, reject, or roll it back.

The complete automatic experience is roadmap work. The engine and several bounded
sub-surfaces now ship in the monorepo; that is not proof that the full experience or its
real-life usefulness has shipped.

## Competitive boundary, not a graph checkbox

As of 2026-07-30, AttuneGraph must not be positioned as “the only agent with SQLite, Markdown,
RAG, or a graph-shaped UI.”

- OpenClaw documents a strong built-in per-agent SQLite memory index with FTS5/BM25,
  embeddings, hybrid ranking, provenance metadata, optional `sqlite-vec`, WAL maintenance,
  and Markdown indexing. Its memory files remain the durable human-readable source.
  ([built-in memory](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory-builtin.md),
  [memory overview](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md))
- Hermes described flat `MEMORY.md`/`USER.md` and SQLite FTS5 session search when its typed
  graph-memory proposal was opened, but its later release notes also advertise `/journey`
  and a desktop “memory graph” timeline. The visible graph must therefore not be dismissed
  as nonexistent, nor assumed to prove a graph database or AttuneGraph-equivalent semantic engine.
  ([structured-memory proposal](https://github.com/NousResearch/hermes-agent/issues/346),
  [release notes](https://github.com/NousResearch/hermes-agent/releases))

AttuneGraph's defensible difference is the documented contract it owns end to end: immutable
temporal/provenance/policy evidence, exact scope and snapshot semantics, return and
counterfactual operators, proof-closed token-bounded Working Graphs, typed
completeness/abstention, and local export/rebuild/physical-forget behavior. Until that
contract is implemented and independently qualified, it is a design advantage under
construction rather than a competitor-superiority claim.
The broader primary-source comparison is in the
[AttuneGraph open-source competitive landscape](../../strategy/positioning/attunegraph-competitive-landscape-2026-07-30.md).

The decision-level semantic, snapshot, operator, journal, local-storage, recovery, and
staged-delivery blueprint is maintained separately in
[Muse Agent-Native Graph Core](agent-native-graph-core.md). This document defines the
product engine; the companion blueprint fixes how to build its core without turning a
database SDK into the architecture.

## Implementation status

**Built, not yet product-integrated:** AWG-010 provides the storage-neutral assertion
contract, strict temporal/provenance/epistemic invariants, bounded traversal, in-memory
reference adapter, reusable backend conformance suite, and token-budgeted Activation
Subgraph compiler in [`packages/attunegraph`](../../../packages/attunegraph).
AWG-020 adds a pure, lazy per-thread projection of validated Continuity state: artifact
links, delivery evidence, explicit outcomes, policy versions/revisions, and factual
interaction evidence become content-addressed assertions with scope-safe deltas. The
authoritative store and projector share one I/O-free `unknown → AttunementState` parser;
the graph never reads or owns the file.
The first real-source boundary is now implemented outside this package: the trusted
`@muse/attunement/host` factory performs one byte-bounded read of its configured local
Attunement file and mints a process-local capture. A narrow I/O-free verification subpath
separates serializable receipt integrity from exact in-process Provider provenance,
exposes the complete normalized state only as a non-enumerable immutable string, and
labels freshness `unassessed`. Missing source or thread availability abstains without an
absence claim.
The independently verified head-revalidation sibling is Provider-owned and process-local:
the same configured Provider captures a subject and head under an explicit span bound,
verifies both owner/scope shells before either hidden state, and admits only exact endpoint
equality as `fresh-at-assessment`. Cross-owner, cross-scope, fabricated-stale,
forged-authority, and forged scope-seed receipts fail closed. This is not continuous
stability, freshness after assessment, persistence, or action authority.
The independently verified package-private Provider-bound composition now verifies that
mint before state access,
independently recomputes its bytes and digest, produces and verifies one exact Continuity
Observation Receipt, derives the opaque thread core plus at most 255 deterministic
optionals, and invokes the existing receipt-bound evidence compiler. Provider provenance
has its own grammar rather than impersonating a graph commit or generation. A single
capture is always `unassessed`; that pairing forces graph settlement to abstain while its
receipts still bind the exact source scope, observation, evidence, budget, retained
nominations, and digest-counted overflow. The module is private and process-local. No
runtime, Capsule, durable store, continuous/current freshness claim, or action path
consumes it yet.
The independently verified thread-rooted retained-witness seam conserves the complete
bounded pre-settlement pool behind the exact compilation object. It uses separate
content-addressed core/optional entries, body-bound focus digests, and a compact manifest
for fair-ranked versus lane-undetermined evidence while reusing the already frozen
document/assertion instances. The side inventory is process-local and absent from
enumeration, JSON, receipt IDs, package exports, and settlement semantics. The later
independently verified resume compiler and coordinator now verify an exact previous
boundary plus current Source/Graph pair, settle that inventory under one fixed six-axis
budget, and dogfood frozen semantic facts through explicit Pack Preview. The coordinator
is assembly-local and process-memory only; its 16-entry baseline LRU, bounded concurrency,
capture span, timeout, generation, and monotonicity rules do not establish durable or
current-world truth. A strict optional preparation request can now produce the verified
English/Korean Capsule render-data presentation, but only when both the private Pack sidecar
and four receipt dependencies belong to that exact compared result object.
AWG-030 adds the first verified personal-temporal operator: an isolated
`/continuity-changes` query over two immutable observations and one caller-declared,
version-bound boundary. It normalizes identical-source re-observation, classifies
world-valid versus learned-after changes, conservatively pairs revisions, and returns one
bounded exact thread path or a typed abstention. Its checked controlled replay improves
exact full-path coverage from flat `0.75` to graph `1.0` with equal `1.0` change-detection
precision/recall; vector is not applicable because the projection deliberately carries no
semantic text. This is component evidence, not organic usefulness or a shipped Capsule.
AWG-035a adds the portable seam that AWG-030 did not have: a strict
`/continuity-observations` codec can seal one bounded projection plus its source-accounting
diagnostics into a domain-separated, content-addressed receipt and verify it after JSON
round-trip. It independently rechecks the projection digest and exact timestamp-basis
coverage. The receipt remains `caller-declared-observation`: it proves byte
self-consistency, not that an external observer witnessed that state or time.
The reference traversal separately caps returned assertions, considered adjacency
assertions, visited references, and depth, so a dense seed cannot hide unbounded work behind
a small output limit.
AWG-040a1 adds the first source-side Capsule seam inside `@muse/attunement`: one already
prepared `ContinuityPack` can be projected through a single internal all-source Module.
The Module preserves every current typed display field, validates exact references,
provider/type rules, observable anchor identity, policy/evidence/next-step coherence and
explicit resource budgets, normalizes semantic instants and set-like fields, then returns a
detached deeply frozen value. It deliberately has no graph dependency and makes no
freshness, observation-time, receipt, comparison, or Pack-to-graph binding claim.
AWG-040a2 seals that projection in a separate internal Source Observation Receipt. Capture
accepts one caller-declared observation time, validates the Pack once, requires task,
reminder, and calendar derived display state to match the same versioned Temporal Rule used
by the Pack producer, then computes a domain-separated SHA-256 content address. Verification
reparses the canonical projection and independently checks version, temporal coherence,
complete-receipt bytes, and digest. This is integrity and self-consistency, not an
authenticated witness or source-freshness proof.
AWG-040b is implemented and independently verified. Its internal
`@muse/attunegraph` Capsule compiler accepts previous/current scoped Source Observation
Receipts and previous/current Graph Observation Receipts. Each paired observation must match
the exact source ID, thread, canonical time, complete `CONTEXT_FOR`/`NEXT_STEP_FOR` link-role
set, and policy binding; it then derives one deterministic receipt-to-receipt change result.
The bounded, deeply frozen Capsule Manifest binds all receipt/change IDs and carries
render-ready snapshots of the previous observation's recorded next step and its current
availability, the current next step, and selected current supporting evidence, plus
caller-declared prepared work and expected minutes. It does not establish an observed exact
stopping point. Snapshot text is copied only from verified source truth and remains local
personal data. A `draft` is display-only; an `action-preview` is only a preview and requires
a new approval.

The compiler is neither a user interface nor a durable/persistent Capsule store, source I/O,
tool payload, action path, Graph DB/backend, or dogfood result. Manifest-only verification
checks canonical self-consistency; dependency-aware verification requires all four receipts
and recomputes their binding and change result. AWG-040c is the matching pure,
user-invoked presentation Module: it exposes bounded English/Korean render data with a
visible `caller-declared-owner-request` reason, `not-performed` automatic timing, and the
display-only/new-approval boundary. Its standalone verifier proves canonical
self-consistency only; it does not prove request authentication, source freshness, or an
independent observation. It adds no automatic delivery, UI, persistence, source/store join,
policy mutation, or action authority. AWG-040b/c do not implement core-roadmap onboarding
103 or session-handoff 211.

The AttuneGraph-backed resume path has one narrow application/runtime composition point in
the explicit owner-invoked Pack Preview, including a verified Capsule render-data option.
Pack Preview may first project its verified observation into a separate complete
`muse.local-attunement-timing` scope when `MUSE_ATTUNEGRAPH_DATABASE` is configured, then may
update its bounded comparison baseline: restart-safe local storage in the assembled host, or
process-local state when a direct library/test construction omits the store. The projection
precedes baseline compare-and-set, so results report both internal effects and preserve
uncertainty if a failing dependency cannot prove whether it committed. Its verified current v1
Graph Observation Receipt remains the provider boundary, and neither internal path mutates a
linked source, delivery, outcome, or policy. The path still has no continuous/current-world
ingestion, LLM extraction, automatic Shadow delivery, automatic Capsule delivery, Policy Card
UI, or action authority. The complete three-part signature experience therefore remains a
roadmap claim.

AWG-040e1 adds the provider-neutral preparation/provenance prerequisite without converting
model text into evidence. One assembly-owned service reuses the resume coordinator
(process-local in that original slice; backed by the AWG-040f durable host store in assembled
production); the first qualifying call therefore reports `seeded`, and only an exact later
compared result may reach the configured provider. The provider receives one detached,
content-addressed evidence view containing exact thread/observation receipt identities, available
current artifact snapshots, the current next-step key, and deterministic change/abstention
metadata. Its strict structured output contains only estimated minutes and ordered claim rows.
Every claim must cite unique current source keys; unknown, previous-only, duplicate, malformed,
tool-call, extra-field, model-substitution, timeout, cancellation, or late output rejects the
whole proposal. The separately versioned Manifest, Presentation, and preparation receipt say
`model-generated-proposal`, `citation-binding-verified`, `entailment: not-verified`,
`expectedMinutes: estimate`, and `display-only`. A deterministic English/Korean system title
prevents an uncited model-title path.

The public assembly service and explicit owner-invoked `muse.continuity.capsule.prepare` tool
accept only `threadId` and `locale`; the tool declares `write` risk because a verified request may
project a durable rebuildable observation when configured and may update the bounded comparison
baseline, while never mutating a linked source, delivery, outcome, or policy. Callers cannot
inject draft text, evidence IDs, model/provider, time, or action mode. This
first composition supports local `task | note | reminder` links only and rejects
every other source class in a state preflight before coordinator/model work, then revalidates the
exact captured result before any provider call. AWG-040e1 itself adds no authenticated evidence
witness, persistent baseline, exact/automatic stop capture, semantic-entailment verification,
delivery/outcome/policy mutation, action payload, automatic timing, or usefulness claim. Those
remain qualification work, not properties of AWG-040e1; AWG-040f later supplies the bounded
durable comparison baseline without changing those denials.

AWG-040e2 adds the first explicit product/API projection without widening the evidence contract.
The owner-gated `POST /api/attunement/threads/:threadId/capsule/prepare` route accepts only an
exact locale request, invokes the exact assembly-owned preparation service with the request abort
signal, and returns a private, no-store closed `ready | seeded | unavailable` display DTO. Its
ready projector resolves the exact cited source keys before rendering and exposes only bounded
display fields; it does not disclose source keys, raw references, receipt or evidence identities,
provider/model details, or an action payload. The empty Chat state offers an explicit Prepare
control only after its existing resumable-thread review. It never prepares on render, polls, or
retries automatically; the first assembled-host request may truthfully establish a durable-local
baseline, while direct construction without a store remains process-local.
The rendered Capsule keeps citation binding separate from unverified semantic entailment, states
its display-only/new-approval boundary, and its Continue control writes only the existing local
navigation handoff. Configured HTTP authentication rejects anonymous calls, but that access gate
does not establish an authenticated evidence witness. This slice is not automatic timing or
delivery, exact stop capture, all-source ingestion, semantic truth,
Policy Card control, action execution, or usefulness qualification.

An explicit second composition point now exposes the read-only
`muse.continuity.learning.policy-card.preview` tool over
`@muse/attunegraph/policy-card`. It captures one fresh provider head, derives the thread
scope only from that receipt, and compiles an English or Korean inert card for one exact
current learning opportunity. The card separates authoritative Attunement experience,
structurally validated caller-supplied replay claims whose execution provenance is not
verified, and an exact AttuneGraph explanation locally derived from the assessed
snapshot. One receipt must prove exactly one `DELIVERED_FOR`, `GOVERNED_BY`,
`PRODUCED_OUTCOME`, and `SCOPED_TO` relation with canonical time boundaries. Missing,
ambiguous, stale, cross-scope, invalid, or over-budget evidence holds the card instead of
guessing. This preview writes nothing, approves nothing, and exposes no action payload.
Automatic surfacing, product UI, trusted trial execution, edit/reject persistence, apply,
and rollback remain separate roadmap work.

Fresh Shadow timing decisions now retain their exact bounded policy snapshot, and a
dedicated Graph receipt can bind one such decision only to the original process-local
compared result that owns its Pack plus four Source/Graph receipts. Copies, legacy timing
candidates, mismatched scopes, and Graph observations later than the decision abstain.
This proves decision-time provenance only; it is not automatic timing, a return event,
feedback, a Policy Card, persistence, or a usefulness result.

The next bounded source seam is now implemented separately: only after an owner invokes
`muse continue` or `muse thread continue` and a real Continuity Delivery opens, the timing
store may content-address a `cli-continue` return receipt against the latest strictly prior
unreturned rule-v3 candidate for that thread. Exact Delivery id/open time/thread, decision
time, and elapsed time are bound; missing, simultaneous, ambiguous, or already-linked
candidates do not trigger older backfill. Its fixed authority fields say feedback/outcome
were not inferred, causality was not claimed, reconstruction benefit was not assessed, and
no action was granted. The ledger entry remains a source receipt rather than graph authority.
The configured `AWG-050b3` composition keeps that source authority intact while rebuilding a
complete reserved `muse.local-attunement-timing` scope. It emits only
`Decision PRECEDED Delivery` and return `Evidence OBSERVED_DURING Thread`; both are queryable
through the bounded Working Graph and cannot become feedback, outcome, causality, policy,
action, or permission. The read-only `AWG-050b4` product inspector reads one current persisted
timing snapshot, keeps the receipt primary, and reports `linked` only for one complete,
untruncated reserved-scope Working Graph containing the exact active pair. Partial/truncated
output is `incomplete`; configured graph failure is `unavailable`; no configured database is
`not-configured`. Its authenticated Continuity card exposes the factual interval from the earlier
Shadow decision to the explicit CLI Pack open and the existing authority denials, not a saved-time,
helpfulness, or successful-return claim. It neither records returns nor uses the physical Admin
Interface. Before its first
return-bearing timing-schema-v3 write, Muse preserves the exact validated pre-v3 bytes at
`<timing-file>.pre-v3.json`; rollback must restore that file before reverting code and can
therefore lose timing-only writes made after the backup.

## Why a graph, and where it must beat flat or vector memory

Vector retrieval is useful for “find things similar to this text.” It is not enough for
questions whose answer depends on exact identity, paths, changing validity, or scoped policy:

- Which exact trip thread was this task linked to, by whom, and when?
- What changed after the user stopped, and which source proves each change?
- Did a short transition window precede a used Capsule, or was it merely nearby in time?
- Which policy version produced this offer, what outcomes supported it, and where does the
  proposed change apply?
- If one source is forgotten, which derived claims, Capsules, and Policy Cards become invalid?

AttuneGraph earns its complexity only when it improves these queries over a flat and
vector baseline. “We use Cypher” or “we have connected nodes” is not a product outcome.

## Research snapshot and lessons

This design reviewed primary papers, standards, current official documentation, and current
open-source source trees on 2026-07-31.

Open-source source snapshot:

- Graphiti `00b0130bab4544574deb4ea8b1d30ceb82de9c5c` (Apache-2.0);
- Mem0 `b357a5a1b03c299ec8229c268e63cfac0f7c6566` (Apache-2.0);
- LadybugDB `a10cecbc76e05f993af6c6f4a57edbbf438bb376` (MIT);
- TGMS `6c2d69b084e57abc27ef890e48e21978aea69d2d` (Apache-2.0).

| Reference | Useful mechanism | What Muse should not copy blindly |
|---|---|---|
| [Microsoft GraphRAG](https://www.microsoft.com/en-us/research/project/graphrag/) | Entity/community structure and global-versus-local retrieval over private corpora | It is primarily batch document understanding; Muse's core problem is a changing single-person world and collaboration policy. |
| [Zep / Graphiti paper](https://arxiv.org/html/2501.13956v1) | Episode → entity/fact → community tiers; source lineage; bi-temporal validity; hybrid semantic, keyword, and traversal retrieval | The paper is vendor-authored, some benchmark gains are marginal or category-dependent, and LLM contradiction resolution cannot become Muse's authority. |
| [REMem](https://arxiv.org/abs/2602.13530) | Time-aware episodic gist/fact structure and bounded retrieval around return/decision episodes | Its temporal-window results do not establish that a later return was caused by, or validates, an earlier agent decision. |
| [Graphiti OSS](https://github.com/getzep/graphiti) | Incremental temporal context graph and a graph-driver interface | Provider-specific queries still leak into domain objects; extraction relies heavily on structured LLM output; current Kùzu support is deprecated. |
| [MemoryGraph OSS](https://github.com/memory-graph/memory-graph) | Embedded temporal memory, as-of/history/change queries, and a practical return-briefing workflow | Its generic coding-memory ontology is not an authority model for personal sources, outcomes, or policy. |
| [Independent 2026 LTM comparison](https://arxiv.org/html/2601.07978) | Reproducible cost, resource, retrieval, and accuracy accounting across vector/graph/hybrid systems | Its LoCoMo/cloud-edge setup is not Muse dogfood. It nevertheless falsifies “graph is automatically better”: Graphiti under-retrieved in that setup. |
| [TGMS v2](https://arxiv.org/abs/2607.10265) and [OSS](https://github.com/zxf-work/tgms) | A small typed temporal-operator surface, bi-temporal snapshots, cost guards, content-addressed traces, and explicit completeness taint | It is a very new single-author preprint with a co-designed workload; its baseline and performance numbers are not Muse evidence. Muse should adopt the bounded operator discipline, not its claims. |
| [LongMemEval-V2](https://arxiv.org/abs/2605.12493) | Environment experience needs dynamic-state, workflow, gotcha, and premise memory; file/sandbox evidence gathering can beat conventional RAG | It is a work-in-progress benchmark, and its strongest coding-agent method has high latency. It supports keeping exact source artifacts available, not routing every turn through an expensive agent search. |
| [MOSAIC](https://arxiv.org/abs/2607.16211) | Typed relational memory, save-time neighbor conflict checks, and cheap candidate routing instead of an LLM classifier on every lookup | Its reported benchmark gains are preprint evidence, not a production guarantee. Automatic updates/deletions also conflict with Muse's source authority unless represented as reversible hypotheses. |
| [Mem0 OSS v2→v3 migration](https://github.com/mem0ai/mem0/blob/main/docs/migration/oss-v2-to-v3.mdx) | Multi-signal retrieval and simpler built-in entity linking | Mem0 removed roughly 4,000 lines of external graph-store paths. Backend breadth can become maintenance weight without product proof. |
| [LadybugDB](https://github.com/LadybugDB/ladybug) | Embedded/serverless property graph, Node binding, full-text/vector indexes, WAL, ACID transactions, and no required daemon | It is a young community successor to Kùzu, which was archived in October 2025. It is a bake-off candidate, not an architectural dependency. |
| [SQLite recursive CTE](https://www.sqlite.org/lang_with.html) and [WAL](https://www.sqlite.org/wal.html) | An already-small embedded substrate can traverse bounded trees/graphs and allow readers beside one writer without a graph daemon | It is not a property graph and must not leak SQL into domain operators. If a future adapter enables WAL, Muse must gate a fixed SQLite release: the official WAL page records a rare reset/checkpoint corruption bug fixed in 3.51.3 and backports 3.44.6/3.50.7. |
| [W3C PROV-O](https://www.w3.org/TR/prov-o/) | Explicit generation, derivation, attribution, primary-source, revision, and invalidation relations | Muse should adopt the semantics it needs, not introduce RDF/OWL as a runtime requirement. |
| [Task switching diary study](https://research.microsoft.com/en-us/um/people/horvitz/taskdiary.pdf), [context-cue experiment](https://pubmed.ncbi.nlm.nih.gov/16938050/), and [notification field study](https://www.erichorvitz.com/shamsi_iqbal-eric_horvitz_cscw_2010.pdf) | Observable return triggers, preserved cues, and separate awareness/disruption outcomes | A click, open, or return is not proof of cognitive readiness, reconstructed intent, saved effort, usefulness, or causal benefit. |

The strongest common pattern is not “put embeddings in a graph DB.” It is:

```text
immutable source episode/evidence
  → typed, provenance-bearing assertion
  → temporal validity and supersession
  → hybrid candidate retrieval
  → bounded graph traversal
  → explanation that resolves back to exact sources
```

### Observation Episode: the seam between cold truth and warm projection

The missing primitive for a real Capsule was not another memory database. Once an
authoritative task, note, calendar item, or Continuity record changes, re-running the
projector cannot reconstruct what Muse saw when the user stopped. Muse therefore treats a
small **Observation Episode** as a first-class provenance object:

```text
authoritative state at caller-declared time
  → exact bounded projection + source-accounting diagnostics
  → content-addressed Observation Receipt
  → later current projection
  → verified change operator
```

AWG-035a ships only the receipt format and strict codec. It stores graph assertions,
opaque exact-source references, temporal basis, scope, and diagnostics—not thread titles,
owner notes, artifact summaries, or provider artifact IDs. The hashes and scope are still
personal linkage data; a future durable adapter must add explicit retention, forget, export,
and migration contracts.

AWG-035b is now built at the pure library boundary. The existing state-to-state query and
the public pure
capture adapter share one internal raw-observation preparation seam for strict parsing,
source accounting, and exactly one deterministic projection. A caller can provide one raw
Continuity snapshot and receive the existing content-addressed receipt; Muse still does no
source I/O, automatic observation, or persistence. The state-to-state query now delegates
both lazy source observations to one internal prepared comparison core. That core validates
scope and observation interval before materialization, binds the previous projection to the
caller boundary before reading current truth, then owns all bounded temporal/path comparison
and deterministic result construction. The public observation subpath now verifies one
prior receipt before touching current source state, derives its exact boundary without
caller repetition, projects current once, and returns the same result bytes and result ID
as the raw query across controlled semantic families. Muse therefore has a verified
portable stop-to-current truth operator—not an automatically recorded stop point and not a
Continuity Capsule. This separation keeps the
module deep: public callers depend only on the query and observation surfaces while
canonicalization, tamper detection, projection validation, privacy bounds, version
rejection, and comparison semantics remain behind them.

### All-source projection: preserve useful truth before graph binding

A Capsule needs human-readable current truth that the graph projection intentionally does
not copy: task state, calendar windows, note summaries, owner prompts, URLs, locations,
relationships, birthdays, run/checkpoint metadata, and Work counts. Joining a live
`ContinuityPack` directly to a prior graph receipt would be a shallow and unsafe seam,
because neither side would prove the display values and graph assertions came from a
coherent observation.

AWG-040 therefore begins with a source-side Module:

```text
already-prepared exact ContinuityPack
  → descriptor-safe bounded validation
  → exact 11-type field/provider matrix
  → Pack identity/policy/next-step/anchor coherence
  → canonical immutable Continuity Source Projection
  → shared versioned Temporal Rule at caller-declared observedAt
  → content-addressed Source Observation Receipt
```

These Modules stay in `@muse/attunement`, where `ResolvedArtifact` semantics live.
`@muse/attunegraph` must not import provider-specific display rules, and a third shared
package is not justified before two real adapters need the interface. The next source
receipt now adds caller-declared observation time, clock-relative temporal coherence,
content addressing, and capture/verify. The receipt includes
`muse.continuity-temporal-state.v1`; changing the rule requires explicit old-version
verification or a new receipt format. The next Capsule manifest must bind this source
receipt to graph evidence explicitly rather than joining unrelated live values.

The projection intentionally carries personal display data. Titles, summaries,
owner-authored prompts, browsing URLs, calendar locations, contact relationships and
birthdays are local personal data—not anonymous identifiers or safe telemetry. A durable
consumer must define retention, forget, export, and migration before persisting it.
The current receipt is therefore an internal pure value only. It reads no clock, source,
file, store, model, graph, or network; no automatic capture or durable retention is implied.

## Muse-specific invention: a personal context compiler

The most useful graph is not the largest graph. On every relevant turn, AttuneGraph
should compile a tiny **Activation Subgraph** containing only:

- the active thread and previous observation's recorded next step (or, only after a future
  explicit stop-marker/capture contract, an exact stopping point);
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

### Muse's special move: verified personal temporal operators

The differentiator should not be “the model can query a graph.” Arbitrary graph querying
pushes schema knowledge, cost control, and correctness back into the model. The neutral
Engine now ships one deliberately fixed `decision-query@1` profile, accepted as a canonical
object or bounded AttuneQL. Callers select only seed, scope, time, current/exact head, and
token budget; they cannot remove relationship families, add writes, or turn proximity into
permission. Its receipt is evidence-only and explicitly leaves authority and conflict closure
`not-performed`.

Muse should build its stricter, versioned operator algebra above that honest core boundary,
with results that are deterministic, bounded, content-addressed, and source-resolvable:

- `changesSince(exactBoundary, thread)` — distinguish world-valid changes from facts Muse
  learned later, then return an exact explanation path or abstain;
- `resumeContext(thread, now, tokenBudget)` — compile the smallest sufficient Activation
  Subgraph for one Continuity Capsule;
- `policyEvidence(scope, proposedDelta)` — show supporting, contrary, and missing evidence
  without promoting a policy;
- `forgetImpact(sourceRef)` — preview which projections and explanations would become
  unavailable before an authorized source deletion;
- `decisionCounterfactual(decisionRef)` — compare bounded `silent | digest | offer`
  alternatives without claiming causal effects.

The LLM chooses an operator and phrases a result. Muse performs identity, time arithmetic,
path construction, completeness checks, and authority filtering in code. The returned
trace says not only what was found, but whether the declared bounded evidence domain was
fully enumerated. This is how the graph improves the agent itself: it turns a large,
ambiguous memory-search problem into a few inspectable decision primitives.

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

### `@attunegraph/core` owns

- node/edge/assertion types and schema versions;
- graph invariants and deterministic projection rules;
- query plans expressed in a storage-neutral intermediate form;
- explanation paths and source-resolution requirements;
- rebuild, verify, forget, migration, and fail-closed format contracts;
- a reference in-memory adapter used by conformance tests.

### `@muse/attunegraph` owns

- Personal Continuity projections and change explanations;
- Continuity Capsule and resume-runtime composition;
- claim-safe, read-only Policy Card compilation;
- Shadow decision, provider, and receipt-bound evidence;
- Muse scheduler/control lineage;
- no storage engine, backend implementation, or compatibility alias.

The AWG-070a3a0 portable-format foundation is `verified-current`. The Engine
exposes its exact stored-projection normalizer only as a package-private Module seam, and
[`../../../packages/attunegraph/PORTABLE-FORMAT.md`](../../../packages/attunegraph/PORTABLE-FORMAT.md) fixes `.atgx`
v1 as an implementation-pending normative contract. No codec, export/rebuild,
filesystem/SQLite staging, Worker/admin runtime, or public `./admin` API ships in this
slice. A fresh independent evaluator passed the exact validator, public-surface, and
normative-format gate after the projection-order repair.

AWG-070a3a1a0 is `verified-current`: package-private canonical admission can override
only its body and full-envelope byte ceilings, while exact portable projection admission
returns the Engine-normalized projection with detached scope, generation, commit, and
store-envelope identity. A future encoder still must require caller `expectedScope` and
a mandatory exact-head validation sink. This slice adds no codec, filesystem, SQLite,
Worker, admin, or public export.

### It does not own

- authoritative task, note, calendar, contact, memory, or Attunement state;
- LLM provider selection or prompts;
- UI rendering;
- action approval or execution;
- background scheduling;
- a specific graph database SDK in its public domain API.

### Public Interface

The package ships one neutral, closed `AttuneGraph*` lifecycle:

```ts
interface AttuneGraph {
  head(): Promise<AttuneGraphSnapshot | undefined>;
  project(command: AttuneGraphProjectCommand): Promise<AttuneGraphSnapshot>;
  execute(command: AttuneGraphExecuteCommand): Promise<AttuneGraphOperatorResult>;
  query(command: AttuneGraphDecisionQuery): Promise<AttuneGraphDecisionQueryResult>;
  close(): Promise<void>;
}
```

`openAttuneGraph` requires one explicit Store capability, binds the instance to one
scope, accepts `canonical-projection@1|2`, executes `working-graph@1`, and compiles the
fixed evidence-only `decision-query@1`. `parseAttuneQL()` is only a bounded parser into
that same canonical query; arbitrary traversal, joins, analytics, and writes are absent.
The explicit in-memory Store is a semantic oracle, never a durability fallback.
`openLocalAttuneGraph` ships from `@attunegraph/core/local` for the capability-gated
SQLite profile. Proof-closed Muse operators for `changes-since`, `resume-context`,
`decision-counterfactual`, `policy-evidence`, and `forget-impact` remain roadmap work.
Expert Source and Store Adapter Interfaces stay in separate subpaths. Raw assertion
mutation, SQL/Cypher, and arbitrary traversal plans do not become product Interfaces.

The offline `@attunegraph/core/admin` Interface is also shipped. It opens a
parent-owned snapshot only after the local caller explicitly attests
`sourceState: "closed-quiescent"`, then exposes bounded summary, integrity, and
exact-scope-head reads through a dedicated Worker. Muse's first Adapter is
`muse attunegraph inspect --database <absolute-path> --source-state closed-quiescent`.
It emits no source path or scope IDs. Live-store inspection, write/repair,
backup/restore, export/rebuild activation, and a web Admin remain roadmap work.

The first real Muse writer is the explicit
`@muse/attunegraph/continuity-durable-projection` Module. When
`MUSE_ATTUNEGRAPH_DATABASE` is a non-empty absolute normalized path, the
existing provider-revalidated Continuity Preview composition keeps its v1
Graph Observation Receipt unchanged, re-reads the current validated Attunement
and persisted timing ledgers, verifies the exact source version, and projects a
separately versioned complete observation under
`muse.local-attunement-timing`. Explicit CLI returns invoke the same rebuild.
The Module
serializes calls, reads the restart-safe current head, supplies that exact
optimistic token to the Engine's atomic compare-and-swap, and always closes the
local instance. An external-writer race fails with no retry or overwrite; an
identical receipt replays without advancing generation. It records freshness as
`unknown` because receipt integrity cannot prove current-world freshness. The
Engine refuses observations older than the active source head, and the reserved
scope prevents a legacy provider-only v1 write from erasing composite
relations.
Absent or exactly empty configuration preserves the old Preview path; invalid
non-empty configuration fails assembly creation closed. This is not continuous
Observe, a persisted resume baseline, or default ingestion.

AttuneGraph consumes explicit verified source observations. It must not import every personal store
and create a second composition root. `AttuneGraph*` and Activation Subgraph v1 exports
are the canonical public vocabulary.

## Storage strategy

**SQLite via capability-gated `node:sqlite` is the selected default AttuneGraph Store.** The
physical v1 profile uses the `ATG1` application identity (`0x41544731`). The
durable projection journal, explicit opt-in Continuity Preview writer, and
offline read-only Admin ship; migration, full recovery, automatic/default
runtime composition, backup, physical forget, and scale qualification remain
roadmap work. AttuneGraph owns the logical journal and
domain operators; SQLite owns local transactions, indexes, locking, and crash recovery.

AttuneGraph remains TypeScript-first: the public Interface, graph semantics, validation, and
conformance oracle stay in TypeScript. The synchronous SQLite Implementation must be
isolated from the application event loop. Proof closure, canonical hashing, compression,
rebuild, or physical forget may move to a Rust Node-API/WASM kernel only after
workload-specific measurement includes boundary/serialization overhead and proves a
material end-to-end gain. The accepted performance ladder, corpus matrix, and initial
targets live in
[ADR 0002](../../architecture/adr/0002-attunegraph-language-runtime-boundary.md).

The flagship Muse experience must remain complete with Muse's own local default graph
Module. Neo4j, Graphiti, a hosted graph service, or any other external Graph DB may later
appear only behind an optional storage/interoperability Adapter. No Capsule, Shadow Muse,
Policy Card, explanation, forget, export, or dogfood qualification gate may depend on
installing or operating one. If an external backend improves a proven workload, it must
still preserve identical domain/query contracts and a clean fallback to Muse-owned local
storage.

1. Keep the in-memory reference engine as the semantic oracle and conformance fixture.
2. Implement the SQLite AttuneGraph Store behind the same domain interface with one writer,
   explicit transactions, version-gated WAL/checkpoints, and owner-only files.
3. Keep PostgreSQL as the first optional conformance Adapter for installations already
   using it; it is never required for the local flagship path.
4. Keep Redis out of authoritative storage (optional disposable cache/queue only) and do
   not implement MySQL or a property-graph backend without a demonstrated deployment need.
5. Preserve a canonical Markdown/NDJSON assertion and journal export so the physical
   backend can be rebuilt or replaced.

### Lightweight reference profile

Muse is single-user and its reference profile is intentionally lightweight, so the first
useful engine does not need a distributed graph server or a general-purpose query language.
The reference profile should use:

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

The runtime should use three temperatures:

1. **Cold truth:** tasks, notes, calendar, memory, and Attunement receipts remain in their
   authoritative stores. The graph does not copy their personal text.
2. **Warm thread projection:** only active or recently requested threads keep compact
   assertion/time/adjacency indexes; inactive projections are rebuildable and evictable.
3. **Hot Activation Subgraph:** one request receives a frozen, token-budgeted slice and its
   completeness/provenance trace, then discards working candidates.

This makes graph cost proportional to the user's active threads and the chosen operator,
not to the size of their entire digital life. Lexical/vector indexes may nominate seeds,
but never establish identity, time, truth, policy, or permission.

An embedded third-party engine should replace only the storage adapter after it beats this
profile. If the reference engine already satisfies the single-user product workload, that
is a valid result: Muse can still own an agent-native graph database contract without
shipping a heavyweight daemon.

## Query discipline

The engine uses hybrid retrieval, but each stage has a distinct job:

1. exact IDs and filters establish user, thread, scope, time, and authority;
2. lexical/vector retrieval proposes seed evidence;
3. bounded traversal expands only allowlisted edge types and independently caps candidate
   work, returned assertions, visited references, and hop count;
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
- AttuneGraph.

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
