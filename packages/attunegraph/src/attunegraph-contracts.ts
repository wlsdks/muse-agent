import type { GraphAssertion, GraphRef } from "./types.js";

declare const attuneGraphStoreBrand: unique symbol;
declare const attuneGraphSourceAdapterBrand: unique symbol;

/** Opaque capability. Store adapters are constructed only from the ./backend seam. */
export interface AttuneGraphStore {
  readonly [attuneGraphStoreBrand]: "AttuneGraphStore";
}

/** Reserved opaque capability for bounded source adapters. */
export interface AttuneGraphSourceAdapter {
  readonly [attuneGraphSourceAdapterBrand]: "AttuneGraphSourceAdapter";
}

export interface AttuneGraphScope {
  readonly sourceId: string;
  readonly threadId: string;
}

export interface AttuneGraphSnapshot {
  readonly schemaVersion: 1;
  readonly scope: AttuneGraphScope;
  readonly generation: number;
  readonly commitId: string;
}

export interface AttuneGraphSourceFreshness {
  readonly state: "fresh" | "stale" | "unknown";
  readonly observedAt: string;
}

/**
 * Caller-declared source truth. It is self-consistent evidence, not a claim that
 * a source was independently observed or that the source remains fresh.
 */
export interface AttuneGraphSourceObservation {
  readonly schemaVersion: 1;
  /** Caller-declared bounded correlation key. The engine mints observationId. */
  readonly observationKey: string;
  readonly scope: AttuneGraphScope;
  readonly observedAt: string;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly assertions: readonly GraphAssertion[];
}

export interface AttuneGraphProjectCommand {
  readonly operator: "canonical-projection@1";
  readonly observation: AttuneGraphSourceObservation;
  readonly expectedSnapshot?: AttuneGraphSnapshot;
}

export interface AttuneGraphExecuteCommand {
  readonly operator: "working-graph@1";
  readonly seed: GraphRef;
  readonly now: string;
  readonly maxEstimatedTokens: number;
}

export interface AttuneGraphWorkingGraph {
  readonly assertions: readonly GraphAssertion[];
  readonly refs: readonly GraphRef[];
  readonly seed: GraphRef;
  readonly diagnostics: Readonly<{
    readonly consideredAssertions: number;
    readonly estimatedTokens: number;
    readonly maxDepthReached: number;
    readonly visitedRefs: number;
    readonly truncationReasons: readonly ("token-budget" | "traversal-budget")[];
  }>;
}

export interface AttuneGraphOperatorResult {
  readonly operator: "working-graph@1";
  readonly status: "complete" | "partial" | "abstained";
  readonly snapshot: AttuneGraphSnapshot;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly workingGraph: AttuneGraphWorkingGraph;
}

export interface AttuneGraph {
  /**
   * Reads the exact current projection head for this opened scope.
   * The returned snapshot is an optimistic-concurrency token only; it carries
   * no assertions, source authority, or permission.
   */
  head(): Promise<AttuneGraphSnapshot | undefined>;
  project(command: AttuneGraphProjectCommand): Promise<AttuneGraphSnapshot>;
  execute(command: AttuneGraphExecuteCommand): Promise<AttuneGraphOperatorResult>;
  close(): Promise<void>;
}

export interface OpenAttuneGraphOptions {
  readonly scope: AttuneGraphScope;
  readonly store: AttuneGraphStore;
}
