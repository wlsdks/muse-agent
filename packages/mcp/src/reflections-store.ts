/**
 * Persisted grounded reflections (Muse's "dreaming" — P32 of the-edge.md). When
 * the daemon is idle it synthesises higher-level insights about the user from
 * recent episodes; the GROUNDED ones (each citing the real episode ids it came
 * from) land here so `muse reflections` can surface them with their sources.
 *
 *   - `~/.muse/reflections.json` is the sidecar (FIFO-trimmed, atomic +
 *     mutation-queued write — same primitive as the trust ledger).
 *   - Dedup on the normalised insight so the same recurring theme isn't stored
 *     twice across passes.
 *   - Tolerant reads: missing / bad-JSON / wrong-shape → empty.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

export interface StoredReflection {
  readonly id: string;
  readonly insight: string;
  /** The real episode/note ids this insight is grounded in. */
  readonly sourceIds: readonly string[];
  readonly supportCount: number;
  readonly createdAtMs: number;
}

const MAX_REFLECTIONS = 500;

function isReflection(value: unknown): value is StoredReflection {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string"
    && typeof r.insight === "string" && r.insight.length > 0
    && Array.isArray(r.sourceIds) && r.sourceIds.every((s) => typeof s === "string")
    && typeof r.supportCount === "number" && Number.isFinite(r.supportCount)
    && typeof r.createdAtMs === "number" && Number.isFinite(r.createdAtMs);
}

const normalize = (insight: string): string => insight.toLowerCase().replace(/\s+/gu, " ").trim();

export async function readReflections(file: string): Promise<readonly StoredReflection[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { reflections?: unknown }).reflections)) {
    return [];
  }
  return (parsed as { reflections: unknown[] }).reflections.flatMap((r): readonly StoredReflection[] =>
    isReflection(r) ? [r] : []
  );
}

async function writeReflections(file: string, entries: readonly StoredReflection[]): Promise<void> {
  const trimmed = entries.length > MAX_REFLECTIONS ? entries.slice(entries.length - MAX_REFLECTIONS) : entries;
  await atomicWriteFile(file, `${JSON.stringify({ reflections: trimmed }, null, 2)}\n`);
}

export interface NewReflection {
  readonly id: string;
  readonly insight: string;
  readonly sourceIds: readonly string[];
  readonly supportCount: number;
  readonly createdAtMs: number;
}

/**
 * Add new reflections, skipping any whose insight already exists (normalised).
 * Returns how many were actually added.
 */
export async function addReflections(file: string, incoming: readonly NewReflection[]): Promise<number> {
  if (incoming.length === 0) return 0;
  return withFileMutationQueue(file, async () => {
    const existing = await readReflections(file);
    const seen = new Set(existing.map((r) => normalize(r.insight)));
    const fresh: StoredReflection[] = [];
    for (const r of incoming) {
      const key = normalize(r.insight);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      fresh.push({ createdAtMs: r.createdAtMs, id: r.id, insight: r.insight, sourceIds: [...r.sourceIds], supportCount: r.supportCount });
    }
    if (fresh.length > 0) await writeReflections(file, [...existing, ...fresh]);
    return fresh.length;
  });
}

/** Pure: reflections newest-first. */
export function listReflections(entries: readonly StoredReflection[]): readonly StoredReflection[] {
  return [...entries].sort((a, b) => b.createdAtMs - a.createdAtMs);
}
