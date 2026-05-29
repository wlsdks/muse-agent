/**
 * Trust instrumentation for every proactive surface (Phase 2 of
 * docs/strategy/identity.md). Proactivity is only safe to ship once we can
 * MEASURE that it isn't annoying — so every notice the daemon delivers is
 * recorded here with its deterministic trigger, the user can veto one with a
 * single command (learned avoidance — that source never surfaces again), and a
 * precision score answers "of everything Muse spoke unasked, how much did I
 * keep vs. reject?". This is the gate that earns proactivity (Phase 3): it must
 * prove it can stay quiet before it's allowed to speak more.
 *
 *   - `~/.muse/proactive-trust.json` is the on-disk sidecar (FIFO-trimmed,
 *     atomic write — mirrors `personal-patterns-fired-store`).
 *   - `sourceKey(kind, id)` is the avoidance/veto unit: a veto on a recurring
 *     meeting silences EVERY future occurrence, not just one.
 *   - Pure helpers (`computeTrustScore`, `avoidedSourceKeys`,
 *     `isSourceAvoided`, `withinDailyCap`) let the proactive loop filter +
 *     score without touching disk in the hot path.
 *
 * Tolerant reads: missing / bad-JSON / wrong-shape → empty array. One corrupt
 * row does not sink the file.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export type ProactiveOutcome = "acted" | "kept" | "vetoed";

export interface TrustLedgerEntry {
  /** Avoidance unit — `${kind}:${id}` (e.g. "calendar:evt-42"). */
  readonly sourceKey: string;
  readonly kind: string;
  /** Human label for the scoreboard, e.g. "Q3 budget review". */
  readonly title: string;
  readonly surfacedAtMs: number;
  /**
   * The user's verdict, recorded later. `vetoed` is learned avoidance — the
   * source is silenced going forward. `acted`/`kept` count as the notice
   * having earned its place. Absent = not yet rated.
   */
  readonly outcome?: ProactiveOutcome;
  readonly outcomeAtMs?: number;
  /**
   * True when this entry was created by a pre-emptive veto/keep on a source
   * Muse never actually surfaced (a `muse proactive veto <id>` for something
   * not yet seen). It records the user's avoidance but is NOT a real surface,
   * so it is excluded from the precision math — otherwise vetoing a never-shown
   * source would corrupt the very "what Muse surfaced vs. what you kept" metric.
   */
  readonly recordedWithoutSurface?: boolean;
}

export interface TrustScore {
  readonly surfaced: number;
  readonly acted: number;
  readonly kept: number;
  readonly vetoed: number;
  readonly rated: number;
  /**
   * Fraction of surfaced notices the user did NOT veto, in [0,1]; `null` when
   * nothing has been surfaced yet (no signal). This is the "did proactivity
   * earn its place" number — a vetoed notice is one Muse should not have sent.
   */
  readonly precision: number | null;
}

const MAX_LEDGER_ENTRIES = 2_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export function sourceKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function isTrustLedgerEntry(value: unknown): value is TrustLedgerEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.sourceKey === "string"
    && typeof entry.kind === "string"
    && typeof entry.title === "string"
    && typeof entry.surfacedAtMs === "number"
    && Number.isFinite(entry.surfacedAtMs)
    && (entry.outcome === undefined || entry.outcome === "acted" || entry.outcome === "kept" || entry.outcome === "vetoed")
    && (entry.recordedWithoutSurface === undefined || typeof entry.recordedWithoutSurface === "boolean")
  );
}

export async function readTrustLedger(file: string): Promise<readonly TrustLedgerEntry[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { surfaced?: unknown }).surfaced)) {
    return [];
  }
  return (parsed as { surfaced: unknown[] }).surfaced.flatMap((entry): readonly TrustLedgerEntry[] =>
    isTrustLedgerEntry(entry) ? [entry] : []
  );
}

async function writeTrustLedger(file: string, entries: readonly TrustLedgerEntry[]): Promise<void> {
  const trimmed = entries.length > MAX_LEDGER_ENTRIES
    ? entries.slice(entries.length - MAX_LEDGER_ENTRIES)
    : entries;
  const payload = `${JSON.stringify({ surfaced: trimmed }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, file);
}

/** Append one surfaced-notice record. */
export async function appendSurfaced(
  file: string,
  entry: { readonly kind: string; readonly id: string; readonly title: string; readonly surfacedAtMs: number }
): Promise<void> {
  const existing = await readTrustLedger(file);
  await writeTrustLedger(file, [
    ...existing,
    { kind: entry.kind, sourceKey: sourceKey(entry.kind, entry.id), surfacedAtMs: entry.surfacedAtMs, title: entry.title }
  ]);
}

/**
 * Record the user's verdict on a source. Sets the outcome on its most-recent
 * surfaced-but-unrated entry; if the source was never surfaced (a pre-emptive
 * veto), appends a minimal entry so the avoidance is still remembered.
 * Returns the resolved title for caller feedback.
 */
export async function recordOutcome(
  file: string,
  key: string,
  outcome: ProactiveOutcome,
  atMs: number
): Promise<{ readonly matched: boolean; readonly title: string }> {
  const existing = await readTrustLedger(file);
  let matchedIndex = -1;
  for (let i = existing.length - 1; i >= 0; i -= 1) {
    if (existing[i]!.sourceKey === key && existing[i]!.outcome === undefined) {
      matchedIndex = i;
      break;
    }
  }
  if (matchedIndex >= 0) {
    const target = existing[matchedIndex]!;
    const next = existing.map((entry, i) =>
      i === matchedIndex ? { ...entry, outcome, outcomeAtMs: atMs } : entry
    );
    await writeTrustLedger(file, next);
    return { matched: true, title: target.title };
  }
  const [kind = key] = key.split(":");
  await writeTrustLedger(file, [
    ...existing,
    { kind, outcome, outcomeAtMs: atMs, recordedWithoutSurface: true, sourceKey: key, surfacedAtMs: atMs, title: key }
  ]);
  return { matched: false, title: key };
}

export function computeTrustScore(entries: readonly TrustLedgerEntry[]): TrustScore {
  // Pre-emptive veto/keep on a never-surfaced source is learned avoidance, not
  // a surface — exclude it so it can't inflate the precision denominator.
  const surfaces = entries.filter((entry) => entry.recordedWithoutSurface !== true);
  let acted = 0;
  let kept = 0;
  let vetoed = 0;
  for (const entry of surfaces) {
    if (entry.outcome === "acted") acted += 1;
    else if (entry.outcome === "kept") kept += 1;
    else if (entry.outcome === "vetoed") vetoed += 1;
  }
  const surfaced = surfaces.length;
  return {
    acted,
    kept,
    precision: surfaced === 0 ? null : (surfaced - vetoed) / surfaced,
    rated: acted + kept + vetoed,
    surfaced,
    vetoed
  };
}

/** Sources the user has vetoed — learned avoidance. */
export function avoidedSourceKeys(entries: readonly TrustLedgerEntry[]): ReadonlySet<string> {
  const avoided = new Set<string>();
  for (const entry of entries) {
    if (entry.outcome === "vetoed") avoided.add(entry.sourceKey);
  }
  return avoided;
}

export function isSourceAvoided(entries: readonly TrustLedgerEntry[], kind: string, id: string): boolean {
  return avoidedSourceKeys(entries).has(sourceKey(kind, id));
}

/**
 * True when fewer than `cap` notices were surfaced in the trailing `windowMs`
 * (default 24h) — the daily cap that keeps proactivity from flooding even when
 * many triggers fire at once. `cap <= 0` disables surfacing entirely.
 */
export function withinDailyCap(
  entries: readonly TrustLedgerEntry[],
  nowMs: number,
  cap: number,
  windowMs: number = DAY_MS
): boolean {
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const since = nowMs - windowMs;
  let recent = 0;
  for (const entry of entries) {
    if (entry.surfacedAtMs > since && entry.surfacedAtMs <= nowMs) recent += 1;
  }
  return recent < cap;
}
