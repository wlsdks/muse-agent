/**
 * Pure data layer for belief provenance (`~/.muse/belief-provenance.json`).
 *
 * Hindsight (arXiv 2512.12818): separate the EVIDENCE (what the user said)
 * from the INFERENCE (what Muse concluded). Auto-extract turns a turn into a
 * remembered fact/preference; this store records WHERE that belief came from —
 * when, which session, and a short excerpt of the user's message — so the user
 * can ask `muse memory why <key>` and see the evidence, not just the conclusion.
 *
 * Same durability posture as the other personal stores: atomic fsync+rename
 * write, tolerant read, corrupt store quarantined aside (never destroyed).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Newest entries kept; bounds the file so a chatty extractor can't grow it without limit. */
export const MAX_BELIEF_PROVENANCE_ENTRIES = 1_000;

export interface BeliefProvenance {
  readonly userId: string;
  /** Normalised memory key the belief is stored under. */
  readonly key: string;
  readonly kind: "fact" | "preference";
  /** The value at learn time. */
  readonly value: string;
  /** ISO timestamp the belief was learned. */
  readonly learnedAt: string;
  readonly sessionId?: string;
  /** Sanitized, bounded snippet of the user message that triggered the belief. */
  readonly evidenceExcerpt?: string;
}

export interface BeliefProvenanceStore {
  record(entry: BeliefProvenance): Promise<void>;
  /**
   * Append several entries in ONE read-modify-write. Auto-extract persists a
   * batch of facts/preferences per turn; recording them via N concurrent
   * `record` calls would race on the shared file (last write wins). Callers
   * with multiple entries MUST use this.
   */
  recordMany(entries: readonly BeliefProvenance[]): Promise<void>;
  query(userId: string, key?: string): Promise<readonly BeliefProvenance[]>;
}

export function defaultBeliefProvenanceFile(): string {
  const fromEnv = process.env.MUSE_BELIEF_PROVENANCE_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "belief-provenance.json");
}

async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}

export async function readBeliefProvenance(file: string): Promise<readonly BeliefProvenance[]> {
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
    await quarantineCorruptStore(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { entries: unknown[] }).entries.flatMap((entry): readonly BeliefProvenance[] =>
    isBeliefProvenance(entry) ? [entry] : []
  );
}

export async function writeBeliefProvenance(file: string, entries: readonly BeliefProvenance[]): Promise<void> {
  const payload = `${JSON.stringify({ entries }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

function compareNewestFirst(a: BeliefProvenance, b: BeliefProvenance): number {
  const aMs = Date.parse(a.learnedAt);
  const bMs = Date.parse(b.learnedAt);
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
    if (aMs !== bMs) return bMs - aMs;
  } else if (a.learnedAt !== b.learnedAt) {
    return b.learnedAt.localeCompare(a.learnedAt);
  }
  return 0;
}

export class FileBeliefProvenanceStore implements BeliefProvenanceStore {
  constructor(private readonly file: string = defaultBeliefProvenanceFile()) {}

  async record(entry: BeliefProvenance): Promise<void> {
    await this.recordMany([entry]);
  }

  async recordMany(entries: readonly BeliefProvenance[]): Promise<void> {
    if (entries.length === 0) return;
    const existing = await readBeliefProvenance(this.file);
    const next = [...existing, ...entries].slice(-MAX_BELIEF_PROVENANCE_ENTRIES);
    await writeBeliefProvenance(this.file, next);
  }

  async query(userId: string, key?: string): Promise<readonly BeliefProvenance[]> {
    const all = await readBeliefProvenance(this.file);
    const scoped = all.filter((e) => e.userId === userId && (key === undefined || e.key === key));
    return [...scoped].sort(compareNewestFirst);
  }
}

function isBeliefProvenance(value: unknown): value is BeliefProvenance {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<BeliefProvenance>;
  if (typeof e.userId !== "string" || e.userId.length === 0) return false;
  if (typeof e.key !== "string" || e.key.length === 0) return false;
  if (e.kind !== "fact" && e.kind !== "preference") return false;
  if (typeof e.value !== "string") return false;
  if (typeof e.learnedAt !== "string" || e.learnedAt.length === 0) return false;
  if (e.sessionId !== undefined && typeof e.sessionId !== "string") return false;
  if (e.evidenceExcerpt !== undefined && typeof e.evidenceExcerpt !== "string") return false;
  return true;
}
