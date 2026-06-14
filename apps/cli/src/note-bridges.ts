import { noteLinkKey } from "./notes-links.js";

import type { NoteLinkGraph } from "./notes-links.js";

// Bridge notes — the brokers of your [[wiki-link]] knowledge graph.
//
// Cross-field mechanism: BETWEENNESS CENTRALITY (Freeman, "A Set of Measures
// of Centrality Based on Betweenness", Sociometry 40(1):35-41, 1977) — a node's
// importance is how many of the graph's shortest paths pass THROUGH it, i.e.
// how much it brokers flow between otherwise-separated parts. The conceptual
// cross-field anchor is the ecological KEYSTONE species (Paine, "Food Web
// Complexity and Species Diversity", The American Naturalist 100:65-75, 1966)
// and Burt's STRUCTURAL HOLES / brokerage (Burt, "Structural Holes", 1992): an
// element with impact out of proportion to its abundance because it occupies
// the one position connecting separate communities — remove it and the system
// fragments. In a personal notes corpus that is the note linking your "work"
// cluster to your "health" cluster: low degree, but where cross-domain insight
// lives. This is DISTINCT from `notes hubs` (k-shell coreness on the co-recall
// graph — the dense centre) and `notes related` (a note's neighbours): a bridge
// can be peripheral yet load-bearing precisely because it is the sole connector.
//
// Deterministic by construction (a pure graph algorithm on the existing
// [[wiki-link]] graph), so the small local model never has to compute it.

export interface BridgeNote {
  readonly id: string;
  /** Betweenness: the number of node-pair shortest paths brokered by this note. */
  readonly score: number;
  /** Resolved-link degree (how many notes it directly connects). */
  readonly degree: number;
}

/**
 * Collapse the directed [[wiki-link]] graph into an UNDIRECTED adjacency over
 * RESOLVED note ids only — brokerage is symmetric (a connector connects both
 * ways), and an unresolved link points at no real note so it can bridge nothing.
 * Every known note is a node even with no links (an isolate, betweenness 0).
 */
export function resolvedAdjacency(graph: NoteLinkGraph): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const ensure = (id: string): Set<string> => {
    const existing = adjacency.get(id);
    if (existing) return existing;
    const fresh = new Set<string>();
    adjacency.set(id, fresh);
    return fresh;
  };
  for (const id of graph.keyToId.values()) ensure(id);
  for (const [id, targets] of graph.outbound) {
    ensure(id);
    for (const target of targets) {
      const resolved = graph.keyToId.get(noteLinkKey(target));
      if (resolved && resolved !== id) {
        ensure(id).add(resolved);
        ensure(resolved).add(id);
      }
    }
  }
  return adjacency;
}

/**
 * Betweenness centrality via Brandes' algorithm (Brandes, "A Faster Algorithm
 * for Betweenness Centrality", J. Mathematical Sociology 25(2):163-177, 2001) —
 * unweighted, undirected. O(V·E), fine at personal scale. Returns a raw count
 * of brokered shortest-path pairs per node (undirected → halved so each pair is
 * counted once).
 */
export function betweennessCentrality(adjacency: ReadonlyMap<string, ReadonlySet<string>>): Map<string, number> {
  const nodes = [...adjacency.keys()];
  const centrality = new Map<string, number>(nodes.map((node) => [node, 0]));

  for (const source of nodes) {
    const stack: string[] = [];
    const predecessors = new Map<string, string[]>(nodes.map((node) => [node, []]));
    const sigma = new Map<string, number>(nodes.map((node) => [node, 0]));
    const distance = new Map<string, number>(nodes.map((node) => [node, -1]));
    sigma.set(source, 1);
    distance.set(source, 0);
    const queue: string[] = [source];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++] as string;
      stack.push(v);
      const dv = distance.get(v) as number;
      const sv = sigma.get(v) as number;
      for (const w of adjacency.get(v) ?? []) {
        if ((distance.get(w) as number) < 0) {
          distance.set(w, dv + 1);
          queue.push(w);
        }
        if ((distance.get(w) as number) === dv + 1) {
          sigma.set(w, (sigma.get(w) as number) + sv);
          (predecessors.get(w) as string[]).push(v);
        }
      }
    }
    const delta = new Map<string, number>(nodes.map((node) => [node, 0]));
    while (stack.length > 0) {
      const w = stack.pop() as string;
      const sw = sigma.get(w) as number;
      for (const v of predecessors.get(w) as string[]) {
        const contribution = ((sigma.get(v) as number) / sw) * (1 + (delta.get(w) as number));
        delta.set(v, (delta.get(v) as number) + contribution);
      }
      if (w !== source) {
        centrality.set(w, (centrality.get(w) as number) + (delta.get(w) as number));
      }
    }
  }
  for (const node of nodes) {
    centrality.set(node, (centrality.get(node) as number) / 2);
  }
  return centrality;
}

/**
 * The top-N bridge notes: notes with non-zero betweenness (real brokers — an
 * isolate, a leaf, or a member of a fully-connected clique brokers nothing),
 * ranked by brokerage then id for stable ordering.
 */
export function selectBridges(graph: NoteLinkGraph, limit = 10): BridgeNote[] {
  const adjacency = resolvedAdjacency(graph);
  const centrality = betweennessCentrality(adjacency);
  return [...centrality.entries()]
    .filter(([, score]) => score > 0)
    .map(([id, score]) => ({ id, score: Math.round(score * 100) / 100, degree: (adjacency.get(id) as Set<string>).size }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}

export function formatBridges(bridges: readonly BridgeNote[]): string {
  if (bridges.length === 0) {
    return "No bridge notes — your notes form no clusters that one note connects (add [[wiki-links]] across topics, or this corpus is a single cluster).";
  }
  const lines = bridges.map((bridge, index) => {
    const pairs = bridge.score === 1 ? "1 connection" : `${bridge.score} connections`;
    return `  ${(index + 1).toString()}. ${bridge.id} — brokers ${pairs} between your topics (degree ${bridge.degree.toString()})`;
  });
  return `🌉 Bridge notes — where your separate topics connect:\n${lines.join("\n")}`;
}
