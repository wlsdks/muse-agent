/**
 * Associative recall via Personalized PageRank over a note-link graph.
 * Implements the HippoRAG 2 retrieval mechanism (arXiv:2502.14802, ICML 2025):
 * build an association graph where edges represent shared salient tokens, then
 * run PPR seeded by query-matched nodes to propagate relevance through the
 * graph — reaching bridge notes that share no direct tokens with the query
 * but are token-chained to a primary hit.
 *
 * Pure, deterministic, no I/O, no model calls.
 */

import type { KnowledgeChunk } from "./knowledge-recall.js";
import { lexicalTokens } from "./knowledge-recall.js";

export interface NoteLinkGraph {
  readonly nodes: readonly string[];
  readonly edges: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

export interface PageRankOptions {
  readonly damping?: number;
  readonly iterations?: number;
  readonly epsilon?: number;
}

const PPR_DAMPING_DEFAULT = 0.5;
const PPR_ITERATIONS_DEFAULT = 20;
const PPR_EPSILON_DEFAULT = 1e-6;

function nodeKey(chunk: KnowledgeChunk): string {
  return `${chunk.source}|${chunk.text}`;
}

/**
 * Build an undirected weighted note-association graph (arXiv:2502.14802):
 * an edge between two chunks iff they share ≥1 salient token; edge weight =
 * Σ over shared tokens of 1/df(token), where df = #chunks containing the
 * token. A rare shared name binds strongly; a corpus-common word barely links.
 * Tokens present in every chunk (df === N) contribute no edge. Deterministic.
 */
export function buildNoteLinkGraph(chunks: readonly KnowledgeChunk[]): NoteLinkGraph {
  const n = chunks.length;
  const nodes = chunks.map(nodeKey);

  if (n === 0) {
    return { edges: new Map(), nodes };
  }

  // Token sets per chunk (deduped content tokens).
  const tokenSets = chunks.map((c) => lexicalTokens(c.text));

  // df: number of chunks containing each token.
  const df = new Map<string, number>();
  for (const tokens of tokenSets) {
    for (const token of tokens) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  // Build symmetric weighted adjacency. Only edges between distinct chunks
  // that share at least one token with df < n.
  const adj = new Map<string, Map<string, number>>();
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      let weight = 0;
      for (const token of tokenSets[i]!) {
        if (tokenSets[j]!.has(token)) {
          const d = df.get(token) ?? 1;
          // Tokens in every chunk are corpus-uninformative — no edge contribution.
          if (d < n) {
            weight += 1 / d;
          }
        }
      }
      if (weight > 0) {
        const ki = nodes[i]!;
        const kj = nodes[j]!;
        if (!adj.has(ki)) adj.set(ki, new Map());
        if (!adj.has(kj)) adj.set(kj, new Map());
        adj.get(ki)!.set(kj, weight);
        adj.get(kj)!.set(ki, weight);
      }
    }
  }

  return { edges: adj, nodes };
}

/**
 * Personalized PageRank over the note-link graph (arXiv:2502.14802).
 * Reset/teleport vector = normalized `seeds` (query-relevant nodes).
 * Power iteration, fully deterministic (fixed node order, no randomness).
 * Defaults: damping 0.5, iterations cap 20, epsilon 1e-6.
 * A disconnected node receives only its teleport mass.
 * Empty or all-zero seeds → uniform teleport over all nodes (safe fallback).
 */
export function personalizedPageRank(
  graph: NoteLinkGraph,
  seeds: ReadonlyMap<string, number>,
  opts?: PageRankOptions
): Map<string, number> {
  const nodes = graph.nodes;
  const m = nodes.length;
  if (m === 0) {
    return new Map();
  }

  const damping = clampFinite(opts?.damping, 0, 1, PPR_DAMPING_DEFAULT);
  const maxIter = Math.max(1, Math.trunc(clampFinite(opts?.iterations, 1, 1e6, PPR_ITERATIONS_DEFAULT)));
  const epsilon = Math.max(0, clampFinite(opts?.epsilon, 0, 1, PPR_EPSILON_DEFAULT));

  const teleport = new Map<string, number>();
  let seedSum = 0;
  for (const [key, w] of seeds) {
    if (w > 0) {
      teleport.set(key, w);
      seedSum += w;
    }
  }
  if (seedSum === 0) {
    // Uniform teleport over all nodes — safe deterministic fallback.
    const u = 1 / m;
    for (const node of nodes) {
      teleport.set(node, u);
    }
  } else {
    // Normalize to sum 1.
    for (const [key, w] of teleport) {
      teleport.set(key, w / seedSum);
    }
  }

  // Precompute normalized out-edge weights (row-stochastic transition matrix).
  // out[node] → Map<neighbor, normalizedWeight>
  const out = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    const neighbors = graph.edges.get(node);
    if (!neighbors || neighbors.size === 0) {
      out.set(node, new Map());
      continue;
    }
    let total = 0;
    for (const w of neighbors.values()) {
      total += w;
    }
    const row = new Map<string, number>();
    for (const [nb, w] of neighbors) {
      row.set(nb, w / total);
    }
    out.set(node, row);
  }

  let scores = new Map<string, number>();
  const init = 1 / m;
  for (const node of nodes) {
    scores.set(node, init);
  }

  // Power iteration.
  for (let iter = 0; iter < maxIter; iter += 1) {
    const next = new Map<string, number>();
    let delta = 0;

    // Base teleport contribution for every node.
    for (const node of nodes) {
      next.set(node, (1 - damping) * (teleport.get(node) ?? 0));
    }

    // Propagate damped mass along edges.
    for (const node of nodes) {
      const s = scores.get(node) ?? 0;
      const neighbors = out.get(node)!;
      if (neighbors.size === 0) {
        // Isolated node: redistribute its damped mass back as teleport
        // (dangling-node treatment — mass is absorbed into teleport mass).
        for (const [nb, tp] of teleport) {
          next.set(nb, (next.get(nb) ?? 0) + damping * s * tp);
        }
      } else {
        for (const [nb, w] of neighbors) {
          next.set(nb, (next.get(nb) ?? 0) + damping * s * w);
        }
      }
    }

    // Convergence check (L1 delta).
    for (const node of nodes) {
      delta += Math.abs((next.get(node) ?? 0) - (scores.get(node) ?? 0));
    }

    scores = next;
    if (delta < epsilon) {
      break;
    }
  }

  return scores;
}

function clampFinite(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}
