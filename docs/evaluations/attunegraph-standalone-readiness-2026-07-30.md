---
title: AttuneGraph standalone readiness audit
audience: [engineering, release, agents]
status: superseded-snapshot
observedAt: 2026-07-30
sourceBaseRevision: 4112d54def1d0d7452146ea1f4caa6fb8e0c7676
sourceWorktree: dirty
related:
  - ../architecture/adr/0001-attunegraph-product-module-boundary.md
  - ../design/attunement/attunegraph.md
  - ../../internal/goals/attunegraph-roadmap.md
---

# AttuneGraph standalone readiness audit — 2026-07-30

## Result

**Not qualified for repository extraction or npm publication.**

> This audit is retained as dated evidence. Its package-coupling finding was resolved
> by the canonical split into dependency-free `@attunegraph/core` and Muse-only
> `@muse/attunegraph`; publication and clean-room release gates remain separate work.

AttuneGraph should remain an independent product Module inside the Muse monorepo while its neutral
contract boundary, clean-room build, packed artifact, durable Store, and release gates are
built. Creating a second authoritative repository now would add version and synchronization
work without removing the actual dependency blockers.

This result does not say the current graph semantics are disposable. It says the current
package combines a reusable kernel with Muse-specific Continuity Adapters and has not yet
proved that those parts can be separated without changing behavior.

## Verified current evidence

The audit ran against base revision
`4112d54def1d0d7452146ea1f4caa6fb8e0c7676` plus the uncommitted AttuneGraph worktree. Import counts
used `rg` over production TypeScript; package contents used
`npm pack --dry-run --json --ignore-scripts`. The later qualification command must bind to a
clean exact revision; this snapshot intentionally reports `sourceWorktree: dirty`.

- [`packages/attunegraph/package.json`](../../packages/attunegraph/package.json)
  is `private: true`, version `0.0.0`, and depends on
  `@muse/attunement: workspace:*`.
- The manifest has no package-level `license`, `repository`, `homepage`, `bugs`, `files`,
  `publishConfig`, or `engines` contract.
- Fourteen production source files contain 25 direct import declarations from
  `@muse/attunement` or one of its subpaths.
- The package TypeScript configuration references the private Attunement workspace project;
  its Vitest configuration imports the root Muse test configuration.
- The current only external runtime consumer is `@muse/autoconfigure`, through the
  Continuity resume runtime surface. This keeps the later Muse integration migration
  bounded.
- `npm pack --dry-run --json --ignore-scripts` reported 336 files, 788,230 packed bytes,
  and 4,345,641 unpacked bytes. The artifact includes TypeScript sources, tests, compiled
  tests, source maps, scripts, and `dist/tsconfig.tsbuildinfo`.
- The dry-run inspected the current package directory, but its existing `dist` may lag the
  uncommitted sources. It is packaging-scope evidence, not a current build proof.
- Historical registry checks found `attunegraph` unpublished. That evidence does not
  establish ownership of the `@attunegraph` scope and must be refreshed before release.

## Direct production coupling

The current production files importing private Attunement contracts are:

```text
continuity-capsule-manifest.ts
continuity-capsule-presentation.ts
continuity-projection-identity.ts
continuity-projection.ts
continuity-resume-boundary.ts
continuity-resume-context-budget.ts
continuity-resume-context-orchestrator.ts
continuity-resume-runtime.ts
continuity-source-graph-binding.ts
graph-snapshot-provenance.ts
provider-bound-graph-evidence.ts
provider-head-revalidated-graph-evidence.ts
shadow-decision-receipt-internal.ts
shadow-decision-receipt.ts
```

The portable-looking kernel is already concentrated around graph types, validation,
canonical immutable envelopes, the in-memory Store, bounded settlement, and conformance.
The dependency-bearing files are mainly Muse Continuity projection and runtime workloads.
The extraction seam should therefore move Muse-specific parsing/capture to a Muse Adapter;
it should not copy Attunement validation into AttuneGraph.

## Required sequence

1. Freeze the AttuneGraph public product Interface and label current dependency-bearing Continuity
   subpaths as compatibility/Muse Adapter surfaces.
2. Introduce a neutral AttuneGraph receipt/value contract or a narrow Source Adapter boundary.
   Keep Attunement store parsing, local I/O, and capture minting on the Muse side.
3. Remove the graph package's Attunement project reference and give AttuneGraph package-owned
   TypeScript/Vitest configuration.
4. Add a forbidden-import/API inventory gate over source, emitted JavaScript, and emitted
   declarations.
5. Make SQLite and the in-memory oracle pass the same byte-stable Store/operator
   conformance corpus.
6. Complete portable export/rebuild, corruption/future-version behavior, migration, and
   physical-forget gates.
7. Add a package-local license, changelog, security policy, contribution guide, registry
   metadata, Node engine requirement, and explicit packed-file allowlist.
8. Add one minimal non-Muse example agent and install the packed tarball in a fresh consumer
   project.
9. Only then rehearse a history-preserving split in a throwaway clone and create the
   standalone repository once.

## Proposed fail-closed command

A `qualify:attunegraph-standalone` script — which does not exist yet — should eventually:

1. bind the report to the exact source revision;
2. create a temporary clean-room workspace containing only qualified AttuneGraph packages,
   AttuneGraph-owned documents/examples, and their neutral dependencies;
3. perform a fresh frozen install, build, typecheck, test, and conformance run;
4. reject forbidden Muse/workspace/private imports in source, JavaScript, and declarations;
5. dry-run and create the package tarball with an exact file allowlist;
6. create a second fresh non-workspace consumer, install the tarball, import every public
   subpath, and run the non-Muse example;
7. emit a revision-bound JSON report and fail on unexpected files, root-relative paths,
   workspace protocols, undeclared dependencies, or skipped required checks.

Until this command and the durable qualification gates pass, “standalone-ready target” is
the accurate claim.
