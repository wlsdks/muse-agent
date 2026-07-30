# AttuneGraph native-kernel decision ledger

- Status: active benchmark contract
- Started: 2026-07-30
- Decision owner: AttuneGraph architecture
- Governing ADR:
  [ADR 0002](../architecture/adr/0002-attunegraph-language-runtime-boundary.md)

This ledger records which AttuneGraph operations may move from TypeScript to
Rust, which measurements activate that work, and why a candidate was selected or rejected.
It is not evidence that a native kernel is currently required or shipped.

## Rules

1. Measure the real AttuneGraph operator and corpus, not a generic graph benchmark.
2. Record a TypeScript/SQLite baseline before native work.
3. Optimize indexes, query shape, transaction batching, allocation, and worker isolation
   first.
4. Include Node-API/WASM boundary, copying, and serialization cost in every comparison.
5. Require byte-stable results against the TypeScript semantic oracle.
6. Move one coarse-grained kernel at a time. Never cross the native boundary once per
   assertion, node, or edge.
7. Keep scope, provenance, completeness, policy, and authority decisions in the
   TypeScript Engine.

## Candidate inventory

| Candidate | Exact benchmark unit | Rust-shaped algorithm or primitive | Activation evidence | Current decision |
| --- | --- | --- | --- | --- |
| Working Graph proof closure | One `working-graph@1` over a pinned 10K/100K/1M-assertion snapshot, warm and cold | compact integer-ID adjacency arrays; deterministic bounded BFS/priority settlement; visited/assertion bitsets; proof-dependency closure | p95 misses the interactive target after indexing/allocation work, CPU profile attributes a material share to traversal/settlement, and one batched native call wins end to end | not activated; TypeScript is the oracle |
| Canonical admission and content IDs | A single observation and batches of 1/100/1,000 observations, including hostile-input rejection | iterative canonical JSON encoding over already admitted plain data; streaming cryptographic digest; bounded arena/buffer reuse | canonicalization/hashing is a top CPU/allocation contributor and native batching materially reduces total projection time without weakening hostile-input checks | not activated; security admission remains TypeScript |
| Portable export | Full deterministic journal/snapshot export at 10K/100K/1M assertions | streaming record encoding, checksum tree, optional compression, bounded buffers | export throughput or peak memory misses the maintenance budget after a streaming TypeScript Implementation | not activated; portable format is not yet shipped |
| Deterministic rebuild | Rebuild indexes and snapshots from a verified portable journal | sorted/batched ID interning, adjacency construction, checksum verification, external merge where required | rebuild time or peak memory becomes an operational problem and native work remains byte-identical | not activated; durable Store is not yet shipped |
| Physical forget and compaction | Preview and perform one exact forget closure, then compact and verify | dependency-closure walk, tombstone/live-set bitmap, streaming rewrite, secure temporary-file handling | large forget/compaction misses latency or memory targets after SQL/index optimization; deletion semantics and crash recovery are already proven | not activated; semantics precede acceleration |
| Snapshot compression | Encode/decode cold immutable projection pages | versioned block compression with checksums and bounded decode | measured database/WAL or resident-memory reduction is meaningful and decode cost does not harm warm Working Graph p95 | not activated; no compression format selected |

## Permanently TypeScript-owned decisions

The following are not native-kernel candidates:

- public `AttuneGraph*` command and result validation;
- Source Adapter authority and exact source-identity rules;
- epistemic-class transitions;
- completeness, freshness, abstention, and absence semantics;
- policy evidence, approval, and action-authority decisions;
- operator version selection and compatibility routing;
- user-facing error meaning.

Rust may accelerate data-plane mechanics behind these decisions, but it cannot redefine
their meaning.

## Measurement matrix

Every candidate comparison records:

- exact Git commit, Node/V8/SQLite/Rust versions, OS, architecture, and power mode;
- corpus generator/version and assertion/predicate/degree distribution;
- 10K, 100K, and 1M assertion sizes;
- cold start and warmed steady-state results;
- p50/p95/p99 latency and throughput;
- peak and steady resident memory;
- database, WAL, export, and native-artifact sizes where relevant;
- application-thread event-loop delay;
- boundary calls, bytes copied, and serialization time;
- output digest and conformance-corpus result;
- TypeScript optimized baseline, native result, relative gain, and confidence interval.

## Decision record template

Append one section per evaluated kernel:

```md
## YYYY-MM-DD — <kernel>

- Status: selected | rejected | deferred | superseded
- Commit:
- Corpus:
- TypeScript baseline:
- Native candidate:
- Boundary/copy cost:
- End-to-end change:
- Conformance:
- Operational cost:
- Decision:
- Revisit trigger:
```

No native dependency enters the default AttuneGraph installation until a `selected` record exists
and release automation proves all supported platforms.
