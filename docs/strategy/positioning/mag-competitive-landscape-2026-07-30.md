---
title: MAG open-source competitive landscape
audience: [product, engineering, agents]
status: research-snapshot
observedAt: 2026-07-30
related:
  - ../design/attunement-graph.md
  - ../design/agent-native-graph-core.md
  - ../adr/0001-mag-product-module-boundary.md
---

# MAG open-source competitive landscape — 2026-07-30

## Conclusion

MAG cannot credibly claim uniqueness from “an agent graph,” local SQLite, bi-temporal
facts, provenance, Markdown, Obsidian support, causal links, or a memory graph UI. Current
open-source products already cover each of those ingredients.

MAG's defensible territory is the combined contract:

> exact source authority → immutable evidence receipts → non-interchangeable
> evidence/outcome/policy/approval semantics → proof-closed bounded Working Graph →
> typed completeness or abstention → reversible personal collaboration UX

This is a research snapshot from first-party repositories, documentation, and package
registries. “Not found” means absent from the reviewed official surface, not proven
nonexistent. Project performance claims remain self-reported until Muse reproduces them.

## Current comparators

| Project | Documented architecture | Strong overlap | MAG requirement |
| --- | --- | --- | --- |
| [AgentDB](https://github.com/ruvnet/agentdb) / [RuVector](https://github.com/ruvnet/ruvector) | Rust engine behind Node N-API/WASM; one `.rvf` container for vectors, lexical indexes, learning state, causal graph/hypergraph, and audit data | Single-file local runtime, causal reasoning, feedback ranking, cryptographic audit | Treat single-file startup, audit, and local performance as a benchmark. Do not confuse container lineage with source-derived permission. Its fast-moving alpha surface is not a MAG semantic dependency. |
| [MemoryGraph MCP](https://github.com/memory-graph/memory-graph) | Embedded FalkorDBLite default, SQLite fallback, typed coding-memory relations, MCP/CLI | Explicit [bi-temporal relationship model](https://github.com/memory-graph/memory-graph/blob/main/docs/temporal-memory.md), changes/as-of/history tools, Markdown/JSON export | This is the closest lightweight temporal API comparator. MAG must exceed it on exact observation identity, proof closure, completeness, authority, and reversible policy. |
| [Graphiti](https://github.com/getzep/graphiti) | Episodes become entities and temporal fact edges; hybrid semantic/keyword/graph retrieval; Neo4j/FalkorDB/Neptune backends | Bi-temporal validity/invalidation, episode provenance, custom ontology | MAG must differentiate through deterministic authority-preserving projection and bounded exact operators, not generic episode extraction or LLM contradiction resolution. Graphiti is Apache-2.0; Zep's production engine is not the same open-source artifact. |
| [Neo4j Agent Memory](https://github.com/neo4j-labs/agent-memory) | Connected conversation, POLE+O knowledge, and reasoning/tool-trace layers on Neo4j or hosted NAMS | Temporal facts, entity resolution, reasoning-to-entity audit edges, hosted scopes | Strong provenance comparator but too operationally heavy for MAG's default local path. Add reasoning-touch and temporal-fact cases to conformance; retain embedded Muse-owned storage. |
| [Cognee](https://github.com/topoteretes/cognee) | Relational provenance/document store + vector store + graph; local SQLite/LanceDB/Kùzu defaults or consolidated Postgres | Broad ingestion, time-aware retrieval, dataset ACLs, Markdown and Notion connectors | Do not chase connector breadth. MAG should guarantee exact stable source references, drift/round-trip rules, scope, and authority for a smaller adapter set. |
| [LadybugDB](https://github.com/LadybugDB/ladybug) | Embedded property graph with Cypher, CSR adjacency, ACID/WAL, vector/full-text indexes, WASM and language bindings | Attractive no-daemon physical Store shape | It defines storage, not agent meaning. Keep it only as a future measured MAG Store candidate; require crash, migration, package-size, maintenance, and conformance evidence before considering it over `node:sqlite`. |
| [Grafeo](https://github.com/GrafeoDB/grafeo) | Rust embedded/server graph DB with LPG/RDF, several query languages, MVCC, vector/BM25, CDC, point-in-time recovery, and RBAC | Rich embedded storage, CDC, graph-level grants | Another Store substrate, not MAG Engine. Project feature/performance claims require independent reproduction; added query breadth does not justify default complexity. |
| [OpenClaw](https://github.com/openclaw/openclaw) | Authoritative Markdown with per-agent SQLite FTS/vector/hybrid index and provenance metadata | Strong local Markdown/RAG, provenance, CJK retrieval, action-sensitive memory narrative, Obsidian-friendly wiki workflow | Highest current UX bar for visible provenance and Markdown/Obsidian. OpenClaw documents that memory does not itself enforce policy. MAG must prove enforcement and exact immutable linkage, not ship another attractive wiki. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Native bounded Markdown memory and SQLite FTS5 sessions; pluggable external memory providers | `/journey`, editable/deletable memories and skills, desktop memory-graph timeline, staged learning visibility | Treat the graph view separately from a semantic graph engine. Match its visible approval/edit/delete controls while adding exact temporal/provenance/policy operators. |

## What MAG must own

### Exact authority preservation

Authoritative task, note, calendar, contact, memory, document, and Attunement stores remain
authoritative. Every MAG assertion resolves to immutable observation/source evidence.
Retrieval score, graph adjacency, inference, recurrence, and factual interaction can never
expand permission.

### A typed semantic ladder

MAG keeps observation, evidence, inference, factual interaction, explicit outcome,
feedback, collaboration policy, approval, and action authority non-interchangeable. A Store
schema or model-generated relation cannot promote one class into another.

### Proof-closed bounded context

MAG publishes a Working Graph only when mandatory source, change path, contradiction,
policy version, scope, freshness, completeness, and action-authority boundaries fit
together. Budget exhaustion produces typed partial/abstained output with exact accounting,
not plausible top-k truncation.

### Personal temporal operators

MAG's versioned operators should combine capabilities competitors usually expose
separately:

- exact `changes-since-stop`;
- return timing and reconstruction-cost evidence;
- scoped decision counterfactuals;
- decision-time policy provenance;
- evidence for/against a collaboration policy;
- forward invalidation after correction or forget;
- impact preview before physical forget.

### Reversible Policy Card semantics

A collaboration rule is evidence-backed, versioned, thread/situation scoped, trialable,
editable, rejectable, and rollbackable. Silence, recurrence, graph confidence, or model
preference never promotes it automatically.

### Portable exact-source Adapters

Markdown/Obsidian support means frontmatter, wiki links, embeds, headings, stable block
references, path containment, revision identity, drift, deletion, and round-trip behavior.
Notion support means stable workspace/database/page/block IDs and cursors rather than page
titles. Generic text ingestion is not this contract.

### Local lifecycle guarantees

The local MAG Store must prove journal replay, snapshot consistency, export/rebuild
equivalence, migration, corruption/future-version handling, owner-only files, and physical
forget without an external service.

## What MAG should not build

- a public SQL/Cypher/Gremlin query surface;
- a second document database or lossy copy of source bodies;
- generic connector breadth before Markdown/Obsidian/Notion identity contracts work;
- an LLM-owned ontology or relation promotion path;
- a mandatory vector index for exact operators;
- a custom physical WAL, filesystem database, or distributed graph service;
- Redis/MySQL/property-graph support without a demonstrated workload;
- a graph visualization presented as proof of temporal or authority correctness.

## Naming and release risk

`MAG` is a high-collision acronym. The unscoped npm `mag` package already exists, as do
packages with the same acronym in other registries. Registry checks on 2026-07-30 found no
public `muse-mag` or `@muse/attunement-graph`, but absence does not prove npm-scope
ownership, legal clearance, or future availability.

Use the full name **Muse Attunement Graph** for search and identity, `MAG` only as shorthand,
provisional repository name `muse-mag`, and code package `@muse/attunement-graph` if the
owner controls that scope. Recheck registry availability and obtain name/trademark review
before public release.
