/**
 * The Whetstone weakness ledger (`~/.muse/weaknesses.json`) — the metacognition
 * artifact: a durable, de-duplicated record of the things Muse reliably gets
 * WRONG or can't do, so the agent (and the user) can SEE its weak spots and
 * later grind them down. See `docs/strategy/whetstone.md`.
 *
 * Pure data layer + a deterministic `topicKeyFromMessage` clusterer. This slice
 * only RECORDS (detect → classify → persist); hint injection / spaced
 * re-challenge / the calibration brake are later Whetstone slices.
 *
 * A failure SIGNAL is not always a Muse failure: a refusal can be the grounding
 * edge working correctly (no note exists). The ledger records it anyway as a
 * `grounding-gap` — repeated gaps on one topic are useful self-knowledge ("you
 * keep asking about X and I have nothing — add a note"), distinct from an
 * `unbacked-action` which is always a true failure (claimed an action it never
 * performed).
 *
 * Persistence + I/O layer only. BKT mastery math, the KO-particle topic
 * tokenizer, and the remediation/dev-fixable selectors live in
 * `./weakness-analytics.ts` — re-exported here so the public surface
 * (`@muse/stores`, direct imports) is unchanged.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";
import { bktUpdate, GROUNDED_SUCCESS_RESOLVABLE_AXES, topicKeyFromMessage } from "./weakness-analytics.js";

export {
  askTimeWeaknessNudge,
  bktUpdate,
  BKT_GUESS,
  BKT_LEARN,
  BKT_PRIOR,
  BKT_SLIP,
  isMasteredWeakness,
  remediationHint,
  renderAskTimeNudge,
  selectDevFixableWeaknesses,
  selectRemediableWeaknesses,
  topicKeyFromMessage,
  WEAKNESS_MASTERED_AT,
  WEAKNESS_MASTERY_RETENTION_DAYS,
  type AskTimeNudge,
  type DevFixableWeakness,
  type RemediableWeakness
} from "./weakness-analytics.js";

export const MAX_WEAKNESS_ENTRIES = 2000;

export type WeaknessAxis = "grounding-gap" | "misgrounding" | "source-conflict" | "unbacked-action" | "wrong-tool" | "time-parse" | "other";

export interface WeaknessEntry {
  readonly axis: WeaknessAxis;
  /** A short, normalised topic cluster key derived from the user's message. */
  readonly topic: string;
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** A remediation hint (populated by later Whetstone slices). */
  readonly hint?: string;
  /** BKT mastery estimate: P(known). Absent on legacy entries → treated as not mastered. */
  readonly pKnown?: number;
  /** ISO timestamp of the most recent successful grounded answer for this topic. */
  readonly lastResolved?: string;
}

/**
 * Increment the matching `(axis, topic)` row's count + lastSeen, or insert a new
 * one. Returns a new array (input is not mutated).
 */
export function upsertWeakness(
  entries: readonly WeaknessEntry[],
  signal: { readonly axis: WeaknessAxis; readonly topic: string; readonly nowIso: string; readonly hint?: string; readonly pKnown?: number }
): WeaknessEntry[] {
  const existing = entries.find((entry) => entry.axis === signal.axis && entry.topic === signal.topic);
  if (existing) {
    return entries.map((entry) =>
      entry === existing
        ? {
            ...entry,
            count: entry.count + 1,
            lastSeen: signal.nowIso,
            ...(signal.hint ? { hint: signal.hint } : {}),
            ...(signal.pKnown !== undefined ? { pKnown: signal.pKnown } : {})
          }
        : entry
    );
  }
  return [
    ...entries,
    {
      axis: signal.axis,
      count: 1,
      firstSeen: signal.nowIso,
      lastSeen: signal.nowIso,
      topic: signal.topic,
      ...(signal.hint ? { hint: signal.hint } : {}),
      ...(signal.pKnown !== undefined ? { pKnown: signal.pKnown } : {})
    }
  ];
}

function isWeaknessEntry(value: unknown): value is WeaknessEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["axis"] === "string" &&
    typeof entry["topic"] === "string" &&
    typeof entry["count"] === "number" &&
    typeof entry["firstSeen"] === "string" &&
    typeof entry["lastSeen"] === "string"
  );
}

export async function readWeaknesses(file: string): Promise<readonly WeaknessEntry[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { weaknesses?: unknown }).weaknesses)) {
    return [];
  }
  return (parsed as { weaknesses: unknown[] }).weaknesses.filter(isWeaknessEntry);
}

export async function writeWeaknesses(file: string, entries: readonly WeaknessEntry[]): Promise<void> {
  // Bounded growth: novel (axis,topic) rows accrue forever without a cap.
  // Keep the entries the selectors surface — highest count, then most recent —
  // and evict stale one-offs. Date.parse on a bad value → NaN, treated as oldest.
  const bounded = entries.length > MAX_WEAKNESS_ENTRIES
    ? [...entries].sort((a, b) =>
        b.count - a.count
        || (Number.isFinite(Date.parse(b.lastSeen)) ? Date.parse(b.lastSeen) : 0)
           - (Number.isFinite(Date.parse(a.lastSeen)) ? Date.parse(a.lastSeen) : 0)
      ).slice(0, MAX_WEAKNESS_ENTRIES)
    : entries;
  await atomicWriteFile(file, JSON.stringify({ weaknesses: bounded }, null, 2));
}

/**
 * Read → cluster the message into a topic → upsert the `(axis, topic)` row →
 * write. A no-op when the message carries no salient topic. Best-effort: the
 * caller fires this and ignores errors (a ledger write must never break a turn).
 */
export async function recordWeakness(
  file: string,
  signal: { readonly axis: WeaknessAxis; readonly message: string; readonly nowIso?: string; readonly hint?: string }
): Promise<WeaknessEntry | undefined> {
  const topic = topicKeyFromMessage(signal.message);
  if (topic.length === 0) {
    return undefined;
  }
  // Serialise the read-modify-write: concurrent ask/chat turns write the SAME
  // weaknesses.json, and a bare read→mutate→write loses all but the last writer.
  return withFileMutationQueue(file, async () => {
    const entries = await readWeaknesses(file);
    const prev = entries.find((e) => e.axis === signal.axis && e.topic === topic);
    const next = upsertWeakness(entries, {
      axis: signal.axis,
      nowIso: signal.nowIso ?? new Date().toISOString(),
      topic,
      pKnown: bktUpdate(prev?.pKnown, false),
      ...(signal.hint ? { hint: signal.hint } : {})
    });
    await writeWeaknesses(file, next);
    return next.find((entry) => entry.axis === signal.axis && entry.topic === topic);
  });
}

/**
 * Record a `time-parse` weakness when a time/date phrase the user gave FAILED to
 * resolve — the DETERMINISTIC parser (not the model) said it can't, so this is a
 * code-detected signal, not a self-report. Wires the previously-DEAD `time-parse`
 * axis (declared + remediable + doctor-displayed, but with zero producers) to its
 * real source so a recurring time-misread surfaces in the dev-fixable list. Records
 * only on a genuine failure (`failed` true) and a non-blank phrase — the actuator's
 * success path is untouched. Pure over the injected `recordWeakness`.
 */
export async function recordTimeParseWeakness(
  phrase: string,
  failed: boolean,
  deps: {
    readonly recordWeakness: (file: string, signal: { readonly axis: WeaknessAxis; readonly message: string; readonly nowIso?: string }) => Promise<WeaknessEntry | undefined>;
    readonly weaknessesFile: string;
    readonly nowIso?: string;
  }
): Promise<WeaknessEntry | undefined> {
  if (!failed || phrase.trim().length === 0) return undefined;
  return deps.recordWeakness(deps.weaknessesFile, {
    axis: "time-parse",
    message: phrase,
    ...(deps.nowIso ? { nowIso: deps.nowIso } : {})
  });
}

/**
 * Record a SUCCESSFUL grounded answer for the given message's topic, updating the BKT
 * mastery estimate. Exact topic-key match only — a missed resolve is status quo, never
 * a false resolve. Returns undefined when no matching grounding-gap entry exists
 * (no write performed — no partial side-effect).
 */
export async function recordWeaknessResolved(
  file: string,
  message: string,
  nowIso?: string
): Promise<WeaknessEntry | undefined> {
  const topic = topicKeyFromMessage(message);
  if (topic.length === 0) {
    return undefined;
  }
  return withFileMutationQueue(file, async () => {
    const entries = await readWeaknesses(file);
    // A later grounded success resolves a knowledge-failure axis — both a
    // `grounding-gap` (Muse couldn't answer) AND a `misgrounding` (it answered but its
    // cited source didn't support it — the GROUNDED≠TRUE core failure). Both are learned
    // away by a subsequent grounded answer, so both raise BKT mastery. A dev-fixable
    // actuator axis (time-parse/wrong-tool/unbacked-action) is a code bug, not a
    // knowledge gap a grounded success can fix, so it is NOT resolved here.
    //
    // A topic can carry BOTH resolvable rows at once (grounding-gap + misgrounding —
    // upsertWeakness keys by (axis, topic)); bump EVERY matching row, not just the
    // first-sorted one, else the misgrounding axis stays stuck below mastery forever
    // and the doctor/nudge nag a topic Muse already re-learned (a one-way ratchet).
    const resolvedAt = nowIso ?? new Date().toISOString();
    let firstUpdated: WeaknessEntry | undefined;
    const next = entries.map((e) => {
      if (!GROUNDED_SUCCESS_RESOLVABLE_AXES.has(e.axis) || e.topic !== topic) {
        return e;
      }
      const updated: WeaknessEntry = { ...e, pKnown: bktUpdate(e.pKnown, true), lastResolved: resolvedAt };
      firstUpdated ??= updated;
      return updated;
    });
    if (!firstUpdated) {
      return undefined; // no resolvable row on this topic — no write (no partial side-effect)
    }
    await writeWeaknesses(file, next);
    return firstUpdated;
  });
}
