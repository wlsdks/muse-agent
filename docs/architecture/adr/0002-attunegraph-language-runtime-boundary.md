# ADR 0002: AttuneGraph is TypeScript-first with a benchmark-gated native kernel

- Status: accepted
- Date: 2026-07-30
- Decision owners: Muse architecture
- Related:
  [AttuneGraph product Module boundary](0001-attunegraph-product-module-boundary.md),
  [AttuneGraph](../../design/attunement/attunegraph.md),
  [Agent-Native Graph Core](../../design/attunement/agent-native-graph-core.md),
  [native-kernel decision ledger](../../benchmarks/attunegraph-native-kernel-candidates.md)

## Context

AttuneGraph is intended to leave the Muse monorepo as an embedded agent-native graph product. Its
implementation language therefore affects more than developer preference: installation,
host integration, event-loop isolation, storage throughput, memory use, native packaging,
and the cost of supporting TypeScript, Python, and other agent ecosystems all matter.

TypeScript itself has no distinct runtime. Its types are erased and the emitted JavaScript
runs with the host runtime's behavior. AttuneGraph's current exact operators are also deliberately
bounded: a traversal considers at most 1,024 assertions, returns at most 256, traverses at
most four hops, and emits at most a 32,768-token Working Graph. The selected local Store is
SQLite, whose query and transaction work runs in its native C engine. These facts make a
language rewrite an optimization hypothesis, not established performance work.

There are still real runtime risks. The Node 24 `node:sqlite` `DatabaseSync` Interface is
synchronous, so slow transactions on the application thread can harm Muse responsiveness.
Longer term, large proof-closure traversals, canonical hashing, compression, rebuild, and
physical forget may become CPU- or memory-bound outside SQLite.

## Decision

The **AttuneGraph Engine remains TypeScript-first**. TypeScript owns:

- the public `AttuneGraph*` Interface and versioned command/result contracts;
- scope, snapshot, epistemic, provenance, completeness, and authority semantics;
- Source Adapter composition and operator selection;
- conformance fixtures, portable export schemas, and cross-language SDK contracts.

The default SQLite AttuneGraph Store is an Adapter behind the `AttuneGraphStore` seam. Its synchronous
Implementation must run in an isolated worker when it becomes the Muse production default;
callers never receive a `DatabaseSync`, prepared statement, SQL string, worker, or message
port. One writer per local Store is the default concurrency model. WAL readers, writer
serialization, busy handling, checkpointing, and shutdown live behind that seam.

**Python and Go do not replace the AttuneGraph Engine.**

- Python is a future SDK and Source Adapter language for research, notebooks, and Python
  agent ecosystems. A Python core would add interpreter/environment packaging and ordinary
  CPython concurrency constraints without making SQLite's C engine faster.
- Go is a future option for a standalone daemon or remote deployment Adapter when a
  separately installed binary and many concurrent network clients are real requirements.
  It is not the embedded Node/Muse default because a process or foreign-function seam would
  be paid on every call.

**Rust is the only planned native hot-path language.** It may implement traversal,
proof-closure settlement, canonical hashing, compression, rebuild, or physical-forget
kernels behind the same `AttuneGraphStore`/operator seam. Node hosts use stable Node-API bindings;
portable/browser hosts may use WebAssembly when the workload and feature set justify it.
The existing Rust runner remains a separate sandbox process and is not silently repurposed
as the graph Store.

No native implementation is added merely because a native language can be faster. The
TypeScript implementation remains the executable semantic oracle and cross-implementation
conformance authority.

## Escalation sequence

Performance work follows this order:

1. measure the exact AttuneGraph workload rather than generic graph benchmarks;
2. fix query shape, indexes, transaction batching, allocation, and canonicalization;
3. isolate synchronous SQLite and CPU-heavy work from the application event loop;
4. move only the measured hot kernel to Rust;
5. retain byte-stable TypeScript/Rust conformance and a TypeScript fallback where practical.

The first durable Store qualification must record, at minimum:

- 10k, 100k, and 1m assertion corpus sizes;
- single and 1,000-assertion projection transactions;
- warm and cold `working-graph` operator latency;
- replay, rebuild, export, and physical-forget throughput;
- resident memory, database/WAL size, and event-loop delay;
- Apple Silicon and Linux x86-64 results.

Initial interactive targets are an internal graph contribution of at most 50 ms p95 for a
warm bounded Working Graph at 100k assertions and at most 20 ms p95 application-thread
event-loop delay during normal Store activity. They are engineering targets, not current
benchmark claims. Missing either target first activates worker isolation and profiling, not
an automatic rewrite. A Rust kernel proposal must name the measured operator, demonstrate
a material end-to-end improvement after serialization/binding overhead, and pass the same
semantic corpus. The candidate operation, exact benchmark unit, possible data-plane
algorithm, activation evidence, and every select/reject/defer decision are maintained in
the
[native-kernel decision ledger](../../benchmarks/attunegraph-native-kernel-candidates.md).

## Evidence

- TypeScript documents that types are erased and do not change JavaScript runtime behavior:
  <https://www.typescriptlang.org/docs/handbook/typescript-from-scratch.html#erased-types>.
- Node 24 documents that every `DatabaseSync` and `StatementSync` operation is synchronous:
  <https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html>.
- Node documents worker threads as the parallelism mechanism for CPU-intensive JavaScript:
  <https://nodejs.org/api/worker_threads.html>.
- Node-API is ABI-stable across Node versions and supports native implementations written
  behind its C Interface:
  <https://nodejs.org/api/n-api.html>.
- SQLite positions itself as local application/device storage, and WAL provides pinned read
  snapshots with concurrent readers but only one writer:
  <https://www.sqlite.org/whentouse.html>,
  <https://www.sqlite.org/wal.html>.
- Ordinary CPython builds still serialize Python object access through the GIL:
  <https://docs.python.org/3/c-api/threads.html>.
- Rust's zero-cost abstraction goal makes it suitable for measured data-plane kernels:
  <https://doc.rust-lang.org/book/ch13-04-performance.html>.

## Consequences

This decision preserves Locality: personal collaboration semantics stay in one readable,
provider-neutral TypeScript Module, while storage and compute acceleration vary at explicit
seams. It preserves Leverage: Muse and external TypeScript agents consume the same deep
Interface, Python can receive a thin SDK, and a Rust kernel can improve hot paths without
forking graph meaning.

The trade-off is that AttuneGraph must invest early in a real benchmark corpus, worker lifecycle,
native-artifact release automation if Rust is activated, and conformance across
Implementations. Until those measurements exist, claims are limited to architectural
fitness and deterministic correctness—not superior throughput.
