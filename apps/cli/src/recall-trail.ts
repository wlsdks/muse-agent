/**
 * Co-recall TRAILS — an emergent, usage-based relatedness signal for notes,
 * applying STIGMERGY (ant-colony pheromone trails; Vittori et al., "A stochastic
 * model of ant trail following with two pheromones", 2015, and the Dorigo ACO
 * lineage): when notes are recalled TOGETHER, a unit of "pheromone" is deposited
 * on the edge between them; trails EVAPORATE on a half-life. Notes frequently
 * surfaced together build a strong trail — relatedness the user never typed as a
 * `[[wiki-link]]` and that embedding similarity may miss. Indirect coordination
 * through traces left in the environment, exactly as an ant colony finds paths.
 * Pure + deterministic (the store/ops); IO is the thin read/write at the edges.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface TrailEdge {
  readonly a: string;
  readonly b: string;
  readonly weight: number;
  readonly lastDepositMs: number;
}

export interface CoRecallTrails {
  readonly version: 1;
  readonly trails: Record<string, TrailEdge>;
}

export interface TrailPartner {
  readonly noteId: string;
  readonly strength: number;
}

const SEP = "\u0000"; // NUL — impossible in a filesystem path, a collision-free pair-key separator
const DEFAULT_HALF_LIFE_MS = 30 * 86_400_000; // a trail loses half its strength every 30 days
const MAX_TRAILS = 5000;

const pairKey = (a: string, b: string): string => (a < b ? `${a}${SEP}${b}` : `${b}${SEP}${a}`);

export function emptyTrails(): CoRecallTrails {
  return { trails: {}, version: 1 };
}

/**
 * Deposit one unit of pheromone on every unordered pair among the co-recalled
 * note ids (deduped; needs ≥2 distinct ids or it's a no-op). Weight is capped so
 * a single hot pair can't dominate forever. Evicts the weakest edges past
 * MAX_TRAILS so the store stays bounded. Pure.
 */
export function depositCoRecall(
  trails: CoRecallTrails,
  noteIds: readonly string[],
  nowMs: number,
  options: { readonly deposit?: number; readonly cap?: number } = {}
): CoRecallTrails {
  const deposit = options.deposit ?? 1;
  const cap = options.cap ?? 50;
  const ids = [...new Set(noteIds.filter((id) => id.length > 0))];
  if (ids.length < 2) return trails;
  const next: Record<string, TrailEdge> = { ...trails.trails };
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i]!;
      const b = ids[j]!;
      const key = pairKey(a, b);
      const existing = next[key];
      next[key] = { a: a < b ? a : b, b: a < b ? b : a, lastDepositMs: nowMs, weight: Math.min(cap, (existing?.weight ?? 0) + deposit) };
    }
  }
  const keys = Object.keys(next);
  if (keys.length > MAX_TRAILS) {
    const kept = keys
      .sort((x, y) => evaporatedWeight(next[y]!, nowMs, DEFAULT_HALF_LIFE_MS) - evaporatedWeight(next[x]!, nowMs, DEFAULT_HALF_LIFE_MS))
      .slice(0, MAX_TRAILS);
    const pruned: Record<string, TrailEdge> = {};
    for (const key of kept) pruned[key] = next[key]!;
    return { trails: pruned, version: 1 };
  }
  return { trails: next, version: 1 };
}

function evaporatedWeight(edge: TrailEdge, nowMs: number, halfLifeMs: number): number {
  const age = Math.max(0, nowMs - edge.lastDepositMs);
  return edge.weight * Math.pow(0.5, age / Math.max(1, halfLifeMs));
}

/**
 * The notes most strongly co-recalled with `noteId` right now — each trail's
 * current (evaporation-weighted) strength, strongest first, above `minStrength`,
 * capped at `limit`. Pure.
 */
export function topCoRecalled(
  trails: CoRecallTrails,
  noteId: string,
  nowMs: number,
  options: { readonly halfLifeMs?: number; readonly limit?: number; readonly minStrength?: number } = {}
): readonly TrailPartner[] {
  const halfLifeMs = options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const limit = Math.max(1, Math.trunc(options.limit ?? 10));
  const minStrength = options.minStrength ?? 0.05;
  const out: TrailPartner[] = [];
  for (const edge of Object.values(trails.trails)) {
    if (edge.a !== noteId && edge.b !== noteId) continue;
    const strength = evaporatedWeight(edge, nowMs, halfLifeMs);
    if (strength >= minStrength) out.push({ noteId: edge.a === noteId ? edge.b : edge.a, strength });
  }
  return out.sort((x, y) => y.strength - x.strength).slice(0, limit);
}

export interface NoteCoreRank {
  readonly noteId: string;
  readonly shell: number;
  readonly degree: number;
}

/**
 * k-shell (k-core) decomposition over the co-recall graph (Kitsak, Gallos,
 * Havlin, Liljeros, Muchnik, Stanley & Makse, "Identification of influential
 * spreaders in complex networks", Nature Physics 6:888, 2010, arXiv:1001.5285):
 * the structurally most influential node is the one deepest in the network CORE,
 * found by iterative minimum-degree pruning — NOT the highest-degree node.
 * Repeatedly remove every node at the current minimum degree, stamping it with
 * that degree as its k-shell index; survivors of later rounds form successively
 * deeper cores. Applied to the co-recall trails, the deepest-core notes are the
 * user's load-bearing structural knowledge HUBS — a GLOBAL structural map that
 * the single-node `topCoRecalled` cannot give, and one that provably differs from
 * the naive "most co-recalled" (degree) answer. Edges are trails whose CURRENT
 * evaporated strength clears `minStrength` (undirected, unweighted for the
 * decomposition). Deterministic; ranked by (shell desc, degree desc, id asc).
 */
export function coreShellRanking(
  trails: CoRecallTrails,
  nowMs: number,
  options: { readonly halfLifeMs?: number; readonly minStrength?: number; readonly limit?: number } = {}
): readonly NoteCoreRank[] {
  const halfLifeMs = options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const minStrength = options.minStrength ?? 0.05;
  const limit = Math.max(1, Math.trunc(options.limit ?? 10));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of Object.values(trails.trails)) {
    if (edge.a === edge.b) continue;
    if (evaporatedWeight(edge, nowMs, halfLifeMs) < minStrength) continue;
    (adjacency.get(edge.a) ?? adjacency.set(edge.a, new Set()).get(edge.a)!).add(edge.b);
    (adjacency.get(edge.b) ?? adjacency.set(edge.b, new Set()).get(edge.b)!).add(edge.a);
  }
  if (adjacency.size === 0) return [];
  const originalDegree = new Map<string, number>();
  const remaining = new Map<string, Set<string>>();
  for (const [node, neighbours] of adjacency) {
    originalDegree.set(node, neighbours.size);
    remaining.set(node, new Set(neighbours));
  }
  const shell = new Map<string, number>();
  while (remaining.size > 0) {
    let minDegree = Infinity;
    for (const neighbours of remaining.values()) minDegree = Math.min(minDegree, neighbours.size);
    let peeled = true;
    while (peeled) {
      peeled = false;
      for (const [node, neighbours] of [...remaining]) {
        if (neighbours.size <= minDegree) {
          shell.set(node, minDegree);
          for (const neighbour of neighbours) remaining.get(neighbour)?.delete(node);
          remaining.delete(node);
          peeled = true;
        }
      }
    }
  }
  return [...shell.entries()]
    .map(([noteId, shellIndex]) => ({ degree: originalDegree.get(noteId) ?? 0, noteId, shell: shellIndex }))
    .sort((x, y) => y.shell - x.shell || y.degree - x.degree || x.noteId.localeCompare(y.noteId))
    .slice(0, limit);
}

export function resolveTrailsFile(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.MUSE_RECALL_TRAILS_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "recall-trails.json");
}

/** Read the trail store, fail-soft to empty on any error (missing / corrupt). */
export async function readTrails(file: string): Promise<CoRecallTrails> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && (parsed as CoRecallTrails).version === 1 && (parsed as CoRecallTrails).trails && typeof (parsed as CoRecallTrails).trails === "object") {
      return parsed as CoRecallTrails;
    }
  } catch {
    // missing / unreadable / corrupt — start fresh
  }
  return emptyTrails();
}

export async function writeTrails(file: string, trails: CoRecallTrails): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(trails, null, 2)}\n`, "utf8");
}
