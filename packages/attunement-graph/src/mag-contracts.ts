import type { GraphAssertion, GraphRef } from "./types.js";

declare const magStoreBrand: unique symbol;
declare const magSourceAdapterBrand: unique symbol;

/** Opaque capability. Store adapters are constructed only from the ./backend seam. */
export interface MagStore {
  readonly [magStoreBrand]: "MagStore";
}

/** Reserved opaque capability for bounded source adapters. */
export interface MagSourceAdapter {
  readonly [magSourceAdapterBrand]: "MagSourceAdapter";
}

export interface MagScope {
  readonly sourceId: string;
  readonly threadId: string;
}

export interface MagSnapshot {
  readonly schemaVersion: 1;
  readonly scope: MagScope;
  readonly generation: number;
  readonly commitId: string;
}

export interface MagSourceFreshness {
  readonly state: "fresh" | "stale" | "unknown";
  readonly observedAt: string;
}

/**
 * Caller-declared source truth. It is self-consistent evidence, not a claim that
 * a source was independently observed or that the source remains fresh.
 */
export interface MagSourceObservation {
  readonly schemaVersion: 1;
  /** Caller-declared bounded correlation key. The engine mints observationId. */
  readonly observationKey: string;
  readonly scope: MagScope;
  readonly observedAt: string;
  readonly sourceFreshness: MagSourceFreshness;
  readonly assertions: readonly GraphAssertion[];
}

export interface MagProjectCommand {
  readonly operator: "canonical-projection@1";
  readonly observation: MagSourceObservation;
  readonly expectedSnapshot?: MagSnapshot;
}

export interface MagExecuteCommand {
  readonly operator: "working-graph@1";
  readonly seed: GraphRef;
  readonly now: string;
  readonly maxEstimatedTokens: number;
}

export interface MagWorkingGraph {
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

export interface MagOperatorResult {
  readonly operator: "working-graph@1";
  readonly status: "complete" | "partial" | "abstained";
  readonly snapshot: MagSnapshot;
  readonly sourceFreshness: MagSourceFreshness;
  readonly workingGraph: MagWorkingGraph;
}

export interface Mag {
  project(command: MagProjectCommand): Promise<MagSnapshot>;
  execute(command: MagExecuteCommand): Promise<MagOperatorResult>;
  close(): Promise<void>;
}

export interface OpenMagOptions {
  readonly scope: MagScope;
  readonly store: MagStore;
}
