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

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { inspectReadOnlyJsonSource, quarantineCorruptFile, withFileLock, withFileMutationQueue, type ReadOnlySourceInspection } from "@muse/shared";

import { decryptMemoryEnvelope, encryptMemoryEnvelope, isEncryptedMemoryEnvelope } from "./memory-encryption.js";
import { exactUserMemoryId } from "./memory-user-store-file.js";
import { normalizeMemoryKey, sanitizeUserMemoryValue } from "./memory-user-store.js";

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
  /**
   * How the belief entered memory: `"auto"` = Muse inferred it from a
   * conversation (auto-extract); `"user"` = the user stated/corrected it
   * directly (`muse memory set`). Absent ⇒ treated as `"auto"` (legacy
   * entries predate this field). The evidence↔inference distinction
   * (Hindsight): a user-stated truth outranks an inference.
   */
  readonly source?: "auto" | "user";
  /**
   * `true` for a RETRACTION marker — an explicit user `forget`. It carries no value
   * (the key was dropped), is excluded from value/count aggregation, and makes the
   * key's NEWEST-event the retraction so the auto-extractor won't resurface a fact
   * the user deleted. A later non-retraction event (a deliberate re-`set`) clears it.
   */
  readonly retraction?: boolean;
  /** Exact, idempotent owner choice made from the actionable conflict view. */
  readonly ownerResolution?: {
    readonly action: "keep";
    readonly exactId: string;
    readonly expectedVersion: number;
    readonly requestId: string;
  };
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

export class BeliefProvenanceResolutionError extends Error {
  readonly code: "invalid-request" | "request-reused";

  constructor(code: "invalid-request" | "request-reused", message: string) {
    super(message);
    this.name = "BeliefProvenanceResolutionError";
    this.code = code;
  }
}

export interface BeliefProvenanceSourceSnapshot {
  readonly entries: readonly BeliefProvenance[];
  readonly excludedCount: number;
}

export const FACT_RECALL_LIFECYCLE_POLICY_V1 = "muse.fact-recall-lifecycle.v1";

export type FactRecallState = "active" | "superseded" | "disputed" | "deleted";
export type FactRecallEligibility = "eligible" | "uncertain" | "ineligible";

export interface FactRecallCandidate {
  readonly key: string;
  readonly kind: "fact" | "preference";
  readonly value: string;
}

/**
 * Content-blind recall decision for one flat-store candidate. `key` is already
 * a citation identity; values never enter the receipt so a deleted fact cannot
 * leak through diagnostics after it has been excluded from answer evidence.
 */
export interface FactRecallDecision {
  readonly eligibility: FactRecallEligibility;
  readonly key: string;
  readonly kind: "fact" | "preference";
  readonly policyVersion: typeof FACT_RECALL_LIFECYCLE_POLICY_V1;
  readonly reason:
    | "legacy-no-provenance"
    | "stable-current"
    | "explicit-user-current"
    | "auto-values-conflict"
    | "newer-authoritative-value"
    | "active-retraction"
    | "equal-authority-conflict"
    | "malformed-history"
    | "authority-unavailable";
  readonly state: FactRecallState;
}

export interface MemoryConflictTarget {
  readonly exactId: string;
  readonly key: string;
  readonly kind: "fact" | "preference";
  readonly value: string;
  readonly version: number;
}

export interface MemoryConflictSource {
  readonly learnedAt: string;
  readonly retraction: boolean;
  readonly sessionId?: string;
  readonly source: "auto" | "user";
  readonly sourceId: string;
  readonly value?: string;
}

export interface MemoryConflictView {
  readonly currentPolicy: {
    readonly eligibility: FactRecallEligibility;
    readonly policyVersion: typeof FACT_RECALL_LIFECYCLE_POLICY_V1;
    readonly reason: FactRecallDecision["reason"];
    readonly sourceId?: string;
    readonly state: FactRecallState;
    readonly value?: string;
  };
  readonly sources: readonly MemoryConflictSource[];
  readonly target: MemoryConflictTarget;
}

/**
 * One provenance event projected as a bounded temporal interval. This is a
 * read-only view: it does not select a recall winner or aggregate confidence.
 */
export interface TemporalBeliefProvenanceEvent {
  /** Stable, content-bound locator for this exact provenance event. */
  readonly sourceId: string;
  /** Normalized key used to group events into one temporal history. */
  readonly key: string;
  readonly kind: "fact" | "preference";
  /** Retractions deliberately carry no value into the projection. */
  readonly event: "assertion" | "retraction";
  readonly value?: string;
  /** `user` is direct user authority; `auto` is an inferred entry. */
  readonly sourceAuthority: "auto" | "user";
  /** When this exact event was observed and recorded. */
  readonly observedAt: string;
  /** Start of this event's validity interval. */
  readonly validFrom: string;
  /** First strictly later event for the same normalized key and kind. */
  readonly invalidatedAt?: string;
  /** Current assertion, current retraction, or an event closed by a later one. */
  readonly temporalState: "active" | "historical" | "invalidated";
}

/** A closed, inert response choice for a stale-fact reconfirmation draft. */
export interface StaleFactReconfirmationResponseOption {
  readonly id: "still-current" | "correct" | "skip";
  readonly label: string;
}

/**
 * Read-only reconfirmation prompt for one exact current memory version. This is
 * deliberately a draft, not an approval or mutation request: a later owner
 * control surface must decide whether and how any response changes memory.
 */
export interface StaleFactReconfirmationDraft {
  readonly exactId: string;
  readonly expectedVersion: number;
  readonly key: string;
  readonly kind: "fact";
  readonly value: string;
  readonly sourceId: string;
  readonly sourceAuthority: "auto" | "user";
  readonly observedAt: string;
  readonly validFrom: string;
  readonly question: string;
  readonly responseOptions: readonly StaleFactReconfirmationResponseOption[];
}

/** Stable, content-bound locator for one exact provenance event. */
export function beliefProvenanceSourceId(entry: BeliefProvenance): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      entry.userId,
      entry.kind,
      entry.key,
      entry.value,
      entry.learnedAt,
      entry.sessionId ?? null,
      entry.evidenceExcerpt ?? null,
      entry.source ?? "auto",
      entry.retraction === true,
      entry.ownerResolution ?? null
    ]))
    .digest("hex")
    .slice(0, 32);
  return `bps_v1_${digest}`;
}

/**
 * Read-only actionable conflict projection. It reuses the authoritative recall
 * reducer and deliberately omits evidence excerpts so a conflict list cannot
 * become a second raw-prompt disclosure surface.
 */
export function projectMemoryConflictViews(
  userId: string,
  targets: readonly MemoryConflictTarget[],
  entries: readonly BeliefProvenance[],
  opts: { readonly normalizeKey?: (key: string) => string } = {}
): readonly MemoryConflictView[] {
  const normalizeKey = opts.normalizeKey ?? ((key: string): string => key);
  const scopedEntries = entries.filter((entry) => entry.userId === userId);
  const decisions = projectFactRecallLifecycle(targets, scopedEntries, { normalizeKey });
  const byIdentity = new Map<string, BeliefProvenance[]>();
  for (const entry of scopedEntries) {
    const identity = factRecallIdentity(entry.kind, normalizeKey(entry.key));
    const group = byIdentity.get(identity) ?? [];
    group.push(entry);
    byIdentity.set(identity, group);
  }
  const views: MemoryConflictView[] = [];
  targets.forEach((target, index) => {
    const decision = decisions[index]!;
    const group = byIdentity.get(factRecallIdentity(target.kind, normalizeKey(target.key))) ?? [];
    const distinctValues = new Set(
      group
        .filter((entry) => entry.retraction !== true)
        .map((entry) => canonicalFactRecallValue(entry.value))
    );
    if (decision.state === "active" || (distinctValues.size < 2 && decision.state !== "deleted")) return;
    const sources = [...group]
      .sort(compareConflictSources)
      .map((entry): MemoryConflictSource => Object.freeze({
        learnedAt: entry.learnedAt,
        retraction: entry.retraction === true,
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        source: entry.source ?? "auto",
        sourceId: beliefProvenanceSourceId(entry),
        ...(entry.retraction === true ? {} : { value: entry.value })
      }));
    const authoritative = decision.reason === "newer-authoritative-value"
      ? authoritativeConflictEntry(group)
      : undefined;
    views.push(Object.freeze({
      currentPolicy: Object.freeze({
        eligibility: decision.eligibility,
        policyVersion: decision.policyVersion,
        reason: decision.reason,
        ...(authoritative ? { sourceId: beliefProvenanceSourceId(authoritative) } : {}),
        state: decision.state,
        ...(decision.state === "deleted" || decision.reason === "equal-authority-conflict"
          ? {}
          : { value: authoritative?.value ?? target.value })
      }),
      sources: Object.freeze(sources),
      target: Object.freeze({ ...target })
    }));
  });
  return Object.freeze(views.sort((left, right) =>
    left.target.kind.localeCompare(right.target.kind)
    || left.target.key.localeCompare(right.target.key)
    || left.target.exactId.localeCompare(right.target.exactId)
  ));
}

/**
 * Project one user's append-only provenance events into temporal intervals.
 * Events sharing a timestamp remain simultaneous: only a strictly later event
 * closes an interval, so this view cannot introduce an arbitrary winner for an
 * equal-time conflict. Malformed scoped input fails closed as an empty view.
 */
export function projectTemporalBeliefProvenance(
  userId: string,
  entries: readonly BeliefProvenance[],
  opts: { readonly normalizeKey?: (key: string) => string } = {}
): readonly TemporalBeliefProvenanceEvent[] {
  if (typeof userId !== "string" || userId.length === 0
    || !Array.isArray(entries) || !opts || typeof opts !== "object") return Object.freeze([]);
  const suppliedNormalizeKey = opts.normalizeKey;
  if (suppliedNormalizeKey !== undefined && typeof suppliedNormalizeKey !== "function") return Object.freeze([]);
  const normalizeKey = suppliedNormalizeKey ?? ((key: string): string => key);
  const normalized: Array<{
    readonly entry: BeliefProvenance;
    readonly key: string;
    readonly sourceId: string;
    readonly timestamp: number;
  }> = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return Object.freeze([]);
    const rawUserId = (entry as { readonly userId?: unknown }).userId;
    // A clearly scoped event owned by somebody else cannot corrupt or erase
    // this user's read model. Missing/invalid/ambiguous ownership still fails
    // closed through the full validator below.
    if (typeof rawUserId === "string" && rawUserId.length > 0 && rawUserId !== userId) continue;
    // Do not expose a partial history when a malformed event could be a later
    // correction/retraction. `isBeliefProvenance` also validates learnedAt.
    if (!isBeliefProvenance(entry)) return Object.freeze([]);
    let key: string;
    try {
      key = normalizeKey(entry.key);
    } catch {
      return Object.freeze([]);
    }
    if (typeof key !== "string" || key.length === 0) return Object.freeze([]);
    const timestamp = Date.parse(entry.learnedAt);
    if (!Number.isFinite(timestamp)) return Object.freeze([]);
    normalized.push(Object.freeze({
      entry,
      key,
      sourceId: beliefProvenanceSourceId(entry),
      timestamp
    }));
  }

  const byIdentity = new Map<string, typeof normalized>();
  for (const event of normalized) {
    const identity = factRecallIdentity(event.entry.kind, event.key);
    const group = byIdentity.get(identity) ?? [];
    group.push(event);
    byIdentity.set(identity, group);
  }

  const projection: TemporalBeliefProvenanceEvent[] = [];
  for (const group of byIdentity.values()) {
    const latestTimestamp = Math.max(...group.map((event) => event.timestamp));
    for (const event of group) {
      const next = group
        .filter((candidate) => candidate.timestamp > event.timestamp)
        .sort((left, right) => left.timestamp - right.timestamp || left.sourceId.localeCompare(right.sourceId))[0];
      const isLatest = event.timestamp === latestTimestamp;
      const temporalState = !isLatest
        ? "historical"
        : event.entry.retraction === true
          ? "invalidated"
          : "active";
      projection.push(Object.freeze({
        event: event.entry.retraction === true ? "retraction" : "assertion",
        ...(next ? { invalidatedAt: next.entry.learnedAt } : {}),
        key: event.key,
        kind: event.entry.kind,
        observedAt: event.entry.learnedAt,
        sourceAuthority: event.entry.source ?? "auto",
        sourceId: event.sourceId,
        temporalState,
        validFrom: event.entry.learnedAt,
        ...(event.entry.retraction === true ? {} : { value: event.entry.value })
      }));
    }
  }
  return Object.freeze(projection.sort((left, right) =>
    left.kind.localeCompare(right.kind)
    || left.key.localeCompare(right.key)
    || left.validFrom.localeCompare(right.validFrom)
    || left.sourceId.localeCompare(right.sourceId)
  ));
}

/**
 * Produce deterministic, mutation-free owner reconfirmation drafts for exact
 * memory entries that are both currently recall-eligible and stale. The
 * lifecycle reducer remains the authority for active/eligible state; the
 * temporal projection supplies the exact still-active provenance event. A
 * missing, malformed, conflicting, retracted, superseded, fresh, or aging
 * input is omitted rather than guessed at. The returned response choices have
 * no action, tool, or write authority.
 */
export function projectStaleFactReconfirmationDrafts(
  userId: string,
  targets: readonly MemoryConflictTarget[],
  entries: readonly BeliefProvenance[],
  opts: {
    readonly now: number;
    readonly staleDays: number;
    readonly normalizeKey: (key: string) => string;
  }
): readonly StaleFactReconfirmationDraft[] {
  if (
    typeof userId !== "string" || userId.length === 0
    || !Array.isArray(targets) || !Array.isArray(entries)
    || !opts || typeof opts !== "object"
    || !Number.isFinite(opts.now) || !Number.isFinite(opts.staleDays) || opts.staleDays < 0
    || typeof opts.normalizeKey !== "function"
  ) return Object.freeze([]);

  if (!targets.every((target) => isExactStaleFactTarget(userId, target))
    || new Set(targets.map((target) => target.exactId)).size !== targets.length) {
    return Object.freeze([]);
  }

  try {
    const scopedEntries = entries.filter((entry) => entry.userId === userId);
    if (!scopedEntries.every(isSafeStaleFactProvenanceEntry)) return Object.freeze([]);

    const temporal = projectTemporalBeliefProvenance(userId, entries, { normalizeKey: opts.normalizeKey });
    if (temporal.length === 0) return Object.freeze([]);

    const lifecycle = projectFactRecallLifecycle(targets, scopedEntries, { normalizeKey: opts.normalizeKey });
    const drafts: StaleFactReconfirmationDraft[] = [];

    targets.forEach((target, index) => {
      const decision = lifecycle[index];
      if (decision?.state !== "active" || decision.eligibility !== "eligible") return;

      const normalizedKey = opts.normalizeKey(target.key);
      const matchingEntries = scopedEntries.filter((entry) =>
        entry.kind === target.kind && opts.normalizeKey(entry.key) === normalizedKey
      );
      const stale = staleFactKeys(
        [target.key],
        deriveFactProvenance(matchingEntries.map((entry) => ({ ...entry, key: normalizedKey }))),
        { normalizeKey: opts.normalizeKey, now: opts.now, staleDays: opts.staleDays }
      );
      if (!stale.has(target.key)) return;

      const activeSources = temporal.filter((event) =>
        event.kind === target.kind
        && event.event === "assertion"
        && event.temporalState === "active"
        && event.value !== undefined
        && opts.normalizeKey(event.key) === normalizedKey
        && canonicalFactRecallValue(event.value) === canonicalFactRecallValue(target.value)
      );
      // Equal-time sources can be temporally simultaneous. A later owner UI
      // must resolve that ambiguity; this draft never chooses one for them.
      if (activeSources.length !== 1) return;
      const source = activeSources[0]!;
      drafts.push(Object.freeze({
        exactId: target.exactId,
        expectedVersion: target.version,
        key: target.key,
        kind: target.kind,
        value: target.value,
        sourceId: source.sourceId,
        sourceAuthority: source.sourceAuthority,
        observedAt: source.observedAt,
        validFrom: source.validFrom,
        question: `Is this ${target.kind} still current: ${target.key} = ${target.value}?`,
        responseOptions: Object.freeze([
          Object.freeze({ id: "still-current", label: "Still current" }),
          Object.freeze({ id: "correct", label: "Correct it" }),
          Object.freeze({ id: "skip", label: "Skip" })
        ])
      }));
    });

    return Object.freeze(drafts.sort((left, right) =>
      left.kind.localeCompare(right.kind)
      || left.key.localeCompare(right.key)
      || left.exactId.localeCompare(right.exactId)
      || left.sourceId.localeCompare(right.sourceId)
    ));
  } catch {
    return Object.freeze([]);
  }
}

function isExactStaleFactTarget(userId: string, value: unknown): value is MemoryConflictTarget & { readonly kind: "fact" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Partial<MemoryConflictTarget>;
  if (typeof target.key !== "string" || target.key.length === 0
    || target.key !== target.key.trim()
    || normalizeMemoryKey(target.key) !== target.key
    || /[\u0000-\u001f\u007f-\u009f]/u.test(target.key)
    || target.kind !== "fact"
    || typeof target.value !== "string" || target.value.length === 0
    || /[\u0000-\u001f\u007f-\u009f]/u.test(target.value)
    || sanitizeUserMemoryValue(target.value) !== target.value
    || typeof target.exactId !== "string"
    || target.exactId !== exactUserMemoryId(userId, "fact", target.key)) return false;
  return typeof target.value === "string"
    && typeof target.version === "number"
    && Number.isSafeInteger(target.version) && target.version >= 1;
}

function isSafeStaleFactProvenanceEntry(value: unknown): value is BeliefProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<BeliefProvenance>;
  if (
    typeof entry.key !== "string" || entry.key.length === 0
    || entry.key !== entry.key.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(entry.key)
    || typeof entry.value !== "string"
    || /[\u0000-\u001f\u007f-\u009f]/u.test(entry.value)
  ) return false;
  return entry.retraction === true
    ? entry.value.length === 0
    : entry.value.length > 0 && sanitizeUserMemoryValue(entry.value) === entry.value;
}

function compareConflictSources(left: BeliefProvenance, right: BeliefProvenance): number {
  const leftTime = Date.parse(left.learnedAt);
  const rightTime = Date.parse(right.learnedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return beliefProvenanceSourceId(left).localeCompare(beliefProvenanceSourceId(right));
}

function authoritativeConflictEntry(group: readonly BeliefProvenance[]): BeliefProvenance | undefined {
  const ordered = group
    .filter((entry) => Number.isFinite(Date.parse(entry.learnedAt)))
    .sort(compareConflictSources);
  return [...ordered].reverse().find((entry) =>
    entry.retraction !== true && entry.source === "user"
  ) ?? [...ordered].reverse().find((entry) => entry.retraction !== true);
}

/** Exact inspection for a status read model; supports encrypted stores without quarantine or rewrite. */
export function inspectBeliefProvenanceSource(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ReadOnlySourceInspection<BeliefProvenanceSourceSnapshot>> {
  return inspectReadOnlyJsonSource(file, (outer) => {
    let parsed = outer;
    if (isEncryptedMemoryEnvelope(parsed)) parsed = JSON.parse(decryptMemoryEnvelope(parsed, env)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "entries") || !Array.isArray(record.entries)) return undefined;
    const entries = record.entries.filter(isBeliefProvenance);
    return { entries, excludedCount: record.entries.length - entries.length };
  });
}

/** Per-key provenance derived from the append-only log: the signal a freshness /
 *  promotion layer needs, without migrating the flat `facts` store. */
export interface FactProvenance {
  readonly key: string;
  readonly kind: "fact" | "preference";
  readonly value: string;
  /** Earliest learnedAt for this key — when Muse first learned it. */
  readonly firstSeen: string;
  /** Latest learnedAt — when it was most recently (re)stated/confirmed. */
  readonly lastConfirmed: string;
  /** How many times the key was (re)learned across the log. */
  readonly confirmCount: number;
  /**
   * How many DISTINCT values the key has held across the log. 1 = stable (every
   * confirmation agreed); > 1 = VOLATILE (the belief flipped — "address X → Y → Z").
   * A high confirmCount with distinctValueCount > 1 is re-confirmation of a CHANGING
   * belief, not a stable truth — the opposite signal, so it must NOT auto-promote.
   */
  readonly distinctValueCount: number;
  /** `user` if ANY confirmation was user-stated (a user truth outranks auto). */
  readonly source: "auto" | "user";
}

export type FactFreshness = "fresh" | "aging" | "stale";

const DEFAULT_FACT_AGING_DAYS = 30;
const DEFAULT_FACT_STALE_DAYS = 90;

/** Lowercased content tokens (Unicode) for the refinement subset check. */
function valueTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0));
}

function isTokenSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/**
 * Classify how a NEW value relates to an OLD one — deterministic, token-based (no
 * model): `same` (equal), `refine` (one value's tokens are a SUPERSET of the other's —
 * an elaboration "Seoul" → "Seoul, Gangnam-gu", or its narrowing), or `contradict` (an
 * unrelated value = a genuine flip). Stops a more-SPECIFIC re-statement from being
 * mistaken for a contested value-change in the volatility/contested signal. Pure.
 */
export function classifyValueChange(oldValue: string, newValue: string): "same" | "refine" | "contradict" {
  if (oldValue.trim().toLowerCase() === newValue.trim().toLowerCase()) return "same";
  const a = valueTokens(oldValue);
  const b = valueTokens(newValue);
  if (a.size === 0 || b.size === 0) return "contradict";
  return isTokenSubset(a, b) || isTokenSubset(b, a) ? "refine" : "contradict";
}

/**
 * Count the CONTRADICTION-distinct value clusters across a key's values — a refinement
 * chain ("Seoul" ⊂ "Seoul, Gangnam-gu" ⊂ …) collapses to one, a genuine flip ("Seoul"
 * vs "Busan") counts separately. The refinement-aware replacement for a raw
 * `new Set(values).size`, so a more-specific re-statement does not inflate
 * {@link FactProvenance.distinctValueCount} into a FALSE volatility signal.
 * Conservative: only a STRICT token-subset collapses, so a narrowing or a
 * flip stays distinct. Pure.
 */
export function refinementAwareDistinctValueCount(values: readonly string[]): number {
  const unique = [...new Set(values.map((v) => v.trim().toLowerCase()))].filter((v) => v.length > 0);
  if (unique.length <= 1) return unique.length;
  const tokenSets = unique.map((v) => valueTokens(v));
  let count = 0;
  for (let i = 0; i < unique.length; i++) {
    const ti = tokenSets[i] as Set<string>;
    // A value is a refinement (absorbed) iff its tokens are a STRICT subset of another's.
    const absorbed = ti.size > 0 && tokenSets.some((tj, j) => j !== i && ti.size < tj.size && isTokenSubset(ti, tj));
    if (!absorbed) count++;
  }
  return Math.max(1, count);
}

/**
 * Append a RETRACTION marker for an explicit user `forget`, so the auto-extractor
 * won't resurface the dropped fact ({@link keysWithActiveRetraction}). The CLI
 * `memory forget` and the in-chat `/forget` both call this (DRY) — `key` must be the
 * normalized form the store uses. Fail-open caller-side; this resolves once recorded.
 */
export async function recordRetraction(
  store: Pick<BeliefProvenanceStore, "record">,
  userId: string,
  key: string,
  opts?: { readonly nowIso?: string; readonly kind?: "fact" | "preference" }
): Promise<void> {
  await store.record({
    userId,
    key,
    kind: opts?.kind ?? "fact",
    value: "",
    learnedAt: opts?.nowIso ?? new Date().toISOString(),
    retraction: true
  });
}

/**
 * Keys whose NEWEST belief-provenance event is a RETRACTION (an explicit user
 * `forget`) — so the auto-extractor must NOT resurface them. A later non-retraction
 * event (a deliberate re-`set` / re-learn the user authored) is newer, so the key
 * drops out (the user reopened it). Pure over the append-only log.
 */
export function keysWithActiveRetraction(entries: readonly BeliefProvenance[]): ReadonlySet<string> {
  const newestByKey = new Map<string, BeliefProvenance>();
  for (const e of entries) {
    const prev = newestByKey.get(e.key);
    if (!prev || Date.parse(e.learnedAt) >= Date.parse(prev.learnedAt)) newestByKey.set(e.key, e);
  }
  const out = new Set<string>();
  for (const [key, newest] of newestByKey) {
    if (newest.retraction === true) out.add(key);
  }
  return out;
}

/**
 * Project the append-only provenance log into deterministic answer-evidence
 * eligibility for the flat user-memory candidates.
 *
 * Authority is deliberately stricter than write-side aggregation:
 * - an explicit retraction stays deleted until a later explicit user `set`;
 *   an auto extraction can never resurrect it;
 * - the latest explicit user value outranks later auto inference;
 * - a candidate that differs from that authoritative value is superseded;
 * - conflicting auto-only values remain visible only as disputed/uncertain;
 * - an unorderable history containing a retraction fails closed as deleted.
 *
 * No provenance means a legacy candidate remains byte-compatible and active.
 * The caller injects key normalization so this file does not create a cycle
 * back to the user-memory store.
 */
export function projectFactRecallLifecycle(
  candidates: readonly FactRecallCandidate[],
  entries: readonly BeliefProvenance[],
  opts: { readonly normalizeKey?: (key: string) => string } = {}
): readonly FactRecallDecision[] {
  const normalizeKey = opts.normalizeKey ?? ((key: string): string => key);
  const byIdentity = new Map<string, Array<{ readonly entry: BeliefProvenance; readonly index: number; readonly timestamp: number }>>();
  entries.forEach((entry, index) => {
    const identity = factRecallIdentity(entry.kind, normalizeKey(entry.key));
    const group = byIdentity.get(identity) ?? [];
    group.push({ entry, index, timestamp: Date.parse(entry.learnedAt) });
    byIdentity.set(identity, group);
  });

  return Object.freeze(candidates.map((candidate): FactRecallDecision => {
    const group = byIdentity.get(factRecallIdentity(candidate.kind, normalizeKey(candidate.key))) ?? [];
    if (group.length === 0) {
      return freezeFactRecallDecision(candidate, "active", "eligible", "legacy-no-provenance");
    }

    const malformed = group.some(({ timestamp }) => !Number.isFinite(timestamp));
    if (malformed) {
      return group.some(({ entry }) => entry.retraction === true)
        ? freezeFactRecallDecision(candidate, "deleted", "ineligible", "malformed-history")
        : freezeFactRecallDecision(candidate, "disputed", "uncertain", "malformed-history");
    }

    const ordered = [...group].sort(compareFactRecallEvents);
    const latestRetraction = [...ordered].reverse().find(({ entry }) => entry.retraction === true);
    const latestExplicitUser = [...ordered].reverse().find(({ entry }) =>
      entry.retraction !== true && entry.source === "user"
    );
    const latestExplicitTimestamp = latestExplicitUser?.timestamp;
    if (latestExplicitTimestamp !== undefined) {
      const tiedExplicitValues = new Set(ordered
        .filter(({ entry, timestamp }) =>
          timestamp === latestExplicitTimestamp
          && entry.retraction !== true
          && entry.source === "user"
        )
        .map(({ entry }) => canonicalFactRecallValue(entry.value)));
      if (tiedExplicitValues.size > 1) {
        return freezeFactRecallDecision(
          candidate,
          "disputed",
          "uncertain",
          "equal-authority-conflict"
        );
      }
    }
    if (
      latestRetraction
      && (!latestExplicitUser || latestExplicitUser.timestamp <= latestRetraction.timestamp)
    ) {
      return freezeFactRecallDecision(candidate, "deleted", "ineligible", "active-retraction");
    }

    const nonRetractions = ordered.filter(({ entry }) => entry.retraction !== true);
    const authoritative = latestExplicitUser ?? nonRetractions[nonRetractions.length - 1];
    if (!authoritative) {
      return freezeFactRecallDecision(candidate, "deleted", "ineligible", "active-retraction");
    }
    const distinctValues = new Set(nonRetractions.map(({ entry }) => canonicalFactRecallValue(entry.value)));
    if (!latestExplicitUser && distinctValues.size > 1) {
      return freezeFactRecallDecision(candidate, "disputed", "uncertain", "auto-values-conflict");
    }
    if (canonicalFactRecallValue(candidate.value) !== canonicalFactRecallValue(authoritative.entry.value)) {
      return freezeFactRecallDecision(candidate, "superseded", "ineligible", "newer-authoritative-value");
    }
    return latestExplicitUser
      ? freezeFactRecallDecision(candidate, "active", "eligible", "explicit-user-current")
      : freezeFactRecallDecision(candidate, "active", "eligible", "stable-current");
  }));
}

function factRecallIdentity(kind: "fact" | "preference", key: string): string {
  return `${kind}\u0000${key}`;
}

function canonicalFactRecallValue(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

function compareFactRecallEvents(
  left: { readonly index: number; readonly timestamp: number },
  right: { readonly index: number; readonly timestamp: number }
): number {
  return left.timestamp === right.timestamp ? left.index - right.index : left.timestamp - right.timestamp;
}

function freezeFactRecallDecision(
  candidate: FactRecallCandidate,
  state: FactRecallState,
  eligibility: FactRecallEligibility,
  reason: FactRecallDecision["reason"]
): FactRecallDecision {
  return Object.freeze({
    eligibility,
    key: candidate.key,
    kind: candidate.kind,
    policyVersion: FACT_RECALL_LIFECYCLE_POLICY_V1,
    reason,
    state
  });
}

/**
 * Aggregate the append-only belief-provenance LOG into one record per key —
 * firstSeen (earliest learnedAt), lastConfirmed (latest), confirmCount, source
 * (`user` if any confirmation was user-stated — Hindsight: a user truth outranks an
 * auto-inference), and the value carried at the most-recent learnedAt. The data
 * already exists in the log; this DERIVES the per-fact signal a freshness/promotion
 * layer needs, with NO migration of the flat `facts` store. Pure.
 */
export function deriveFactProvenance(entries: readonly BeliefProvenance[]): readonly FactProvenance[] {
  const byKey = new Map<string, BeliefProvenance[]>();
  for (const e of entries) {
    // Retraction markers carry no value — exclude them from value/count aggregation
    // so a forget doesn't pollute confirmCount / distinctValueCount / latest value.
    if (e.retraction === true) continue;
    const group = byKey.get(e.key);
    if (group) group.push(e);
    else byKey.set(e.key, [e]);
  }
  const out: FactProvenance[] = [];
  for (const [key, group] of byKey) {
    const sorted = [...group].sort((a, b) => Date.parse(a.learnedAt) - Date.parse(b.learnedAt));
    const first = sorted[0] as BeliefProvenance;
    const last = sorted[sorted.length - 1] as BeliefProvenance;
    out.push({
      confirmCount: group.length,
      distinctValueCount: refinementAwareDistinctValueCount(group.map((e) => e.value)),
      firstSeen: first.learnedAt,
      key,
      kind: last.kind,
      lastConfirmed: last.learnedAt,
      source: group.some((e) => e.source === "user") ? "user" : "auto",
      value: last.value
    });
  }
  return out;
}

/**
 * Classify a fact's freshness by the age of its lastConfirmed timestamp: `fresh`
 * below agingDays, `aging` up to staleDays, `stale` at/over staleDays. An
 * unparseable timestamp is treated as `fresh` (fail-soft — never nag on bad data).
 */
export function classifyFactFreshness(args: {
  readonly lastConfirmed: string;
  readonly now: number;
  readonly agingDays?: number;
  readonly staleDays?: number;
}): FactFreshness {
  const agingMs = (args.agingDays ?? DEFAULT_FACT_AGING_DAYS) * 86_400_000;
  const staleMs = (args.staleDays ?? DEFAULT_FACT_STALE_DAYS) * 86_400_000;
  const age = args.now - Date.parse(args.lastConfirmed);
  if (!Number.isFinite(age) || age < agingMs) return "fresh";
  return age >= staleMs ? "stale" : "aging";
}

/** A fact that has cleared the durable-promotion gate. */
export interface PromotableFact {
  readonly key: string;
  readonly value: string;
  readonly confirmCount: number;
  readonly lastConfirmed: string;
  readonly source: "auto" | "user";
}

const DEFAULT_PROMOTE_MIN_CONFIRM = 3;
const DEFAULT_PROMOTE_RECENT_DAYS = 90;
const DEFAULT_PROMOTE_MIN_RECALL_COUNT = 3;
const DEFAULT_PROMOTE_MIN_UNIQUE_QUERIES = 3;

/**
 * Per-key RECALL evidence — how often a fact was actually SURFACED in retrieval
 * results (not merely written). `count` is the total surfaced-into-results hits;
 * `uniqueQueries` is the distinct query hashes (so one query repeated N times
 * can't fake demonstrated usefulness — same diversity guard as
 * `selectPromotableMemories.minUniqueQueries`). Fed to {@link selectPromotableFacts}
 * as an OPTIONAL additional gate.
 */
export interface FactRecallStat {
  readonly count: number;
  readonly uniqueQueries: number;
}

/**
 * The durable-promotion gate: which facts have EARNED durable trust. A
 * user-STATED fact is trusted immediately (the user typed it — Hindsight: a user
 * truth outranks an inference, and the latest is their current truth even if it
 * flipped); an AUTO-inferred fact must be re-confirmed `minConfirmCount` times AND
 * recently AND with a STABLE value (`distinctValueCount === 1`). A high
 * confirmCount with the value FLIPPING (`distinctValueCount > 1`) is the auto-
 * extractor giving conflicting values for the key — re-confirmation of a CHANGING
 * belief, the opposite of stable truth — so it stays provisional until the user
 * confirms it. FAIL-CLOSE: a value the injection detector flags is NEVER promoted,
 * however often confirmed. The injection check is INJECTED (`isInjection`) so this
 * layer stays free of the agent-core dependency; the caller passes `isMemoryInjection`.
 *
 * ADDITIONAL recall gate (T2-c) — OPT-IN, off by omission. When `recallStats` is
 * ABSENT the behaviour is BYTE-IDENTICAL to the write-side gate above (no recall
 * requirement). When PRESENT it is an ADDITIONAL, ANDed requirement: a fact
 * promotes only if it was ALSO SURFACED in retrieval results at least
 * `minRecallCount` times across ≥ `minUniqueQueries` distinct queries — a fact
 * nobody ever recalls hasn't earned a spot in the always-on persona, however
 * often it was written. A key with no recall entry has zero recall and fails the
 * bar. The caller passes `recallStats` only when its (fail-soft) read of the
 * fact-recall ledger succeeded; on a read error it OMITS `recallStats`, which
 * falls this back to the legacy (no-recall) arm rather than blocking every
 * promotion. Pure.
 */
export function selectPromotableFacts(
  provenance: readonly FactProvenance[],
  opts: {
    readonly now: number;
    readonly minConfirmCount?: number;
    readonly recentDays?: number;
    readonly isInjection?: (value: string) => boolean;
    readonly recallStats?: ReadonlyMap<string, FactRecallStat>;
    readonly minRecallCount?: number;
    readonly minUniqueQueries?: number;
  }
): readonly PromotableFact[] {
  const minConfirm = Math.max(1, Math.trunc(opts.minConfirmCount ?? DEFAULT_PROMOTE_MIN_CONFIRM));
  const recentMs = Math.max(1, opts.recentDays ?? DEFAULT_PROMOTE_RECENT_DAYS) * 86_400_000;
  const isInjection = opts.isInjection ?? ((): boolean => false);
  const recent = (lastConfirmed: string): boolean => {
    const age = opts.now - Date.parse(lastConfirmed);
    return Number.isFinite(age) && age <= recentMs;
  };
  const { recallStats } = opts;
  const minRecallCount = Math.max(1, Math.trunc(opts.minRecallCount ?? DEFAULT_PROMOTE_MIN_RECALL_COUNT));
  const minUniqueQueries = Math.max(1, Math.trunc(opts.minUniqueQueries ?? DEFAULT_PROMOTE_MIN_UNIQUE_QUERIES));
  const recalledEnough = (key: string): boolean => {
    if (!recallStats) return true; // recall gate inactive ⇒ legacy behaviour
    const stat = recallStats.get(key);
    if (!stat) return false; // never surfaced in retrieval ⇒ fails the recall bar
    return stat.count >= minRecallCount && stat.uniqueQueries >= minUniqueQueries;
  };
  return provenance
    .filter((p) => !isInjection(p.value))
    .filter((p) => p.source === "user" || (p.confirmCount >= minConfirm && recent(p.lastConfirmed) && p.distinctValueCount === 1))
    .filter((p) => recalledEnough(p.key))
    .map((p) => ({ confirmCount: p.confirmCount, key: p.key, lastConfirmed: p.lastConfirmed, source: p.source, value: p.value }));
}

/**
 * Of `matchedKeys`, the ones that are PROVISIONAL — KNOWN in the provenance log but
 * NOT durable (failed {@link selectPromotableFacts}): a once-seen auto-extract not yet
 * re-confirmed, which should be grounded cautiously, not asserted as confirmed truth.
 * A key with NO provenance entry is treated as UNKNOWN (not provisional) so legacy
 * facts learned before provenance tracking aren't over-marked. Keys are compared
 * through the injected `normalizeKey` (the matched-fact and provenance key spaces may
 * normalize differently); the ORIGINAL matched key is returned for the caller's lookup.
 * Pure.
 */
export function provisionalFactKeys(
  matchedKeys: readonly string[],
  provenance: readonly FactProvenance[],
  opts: { readonly now: number; readonly isInjection?: (value: string) => boolean; readonly normalizeKey?: (key: string) => string }
): ReadonlySet<string> {
  const norm = opts.normalizeKey ?? ((key: string): string => key);
  const known = new Set(provenance.map((p) => norm(p.key)));
  const durableArgs = opts.isInjection ? { isInjection: opts.isInjection, now: opts.now } : { now: opts.now };
  const durable = new Set(selectPromotableFacts(provenance, durableArgs).map((p) => norm(p.key)));
  const out = new Set<string>();
  for (const key of matchedKeys) {
    const k = norm(key);
    if (known.has(k) && !durable.has(k)) out.add(key);
  }
  return out;
}

/**
 * Matched facts whose stored value is CONTESTED — it FLIPPED across confirmations
 * (volatile, {@link selectVolatileBeliefs}). Surfaced at POINT-OF-USE (recall/ask) so a
 * grounded answer cautions "confirm it's current" instead of asserting a value Muse
 * itself knows is unstable — a once-a-day recap nudge is too late for a hot-path answer.
 * Mirrors {@link provisionalFactKeys}: keys compared through the injected `normalizeKey`,
 * the ORIGINAL matched key returned for the caller's lookup. Pure.
 */
export function contestedFactKeys(
  matchedKeys: readonly string[],
  provenance: readonly FactProvenance[],
  opts: { readonly now: number; readonly recentDays?: number; readonly normalizeKey?: (key: string) => string }
): ReadonlySet<string> {
  const norm = opts.normalizeKey ?? ((key: string): string => key);
  // Point-of-use wants EVERY matched volatile key flagged, not the recap's top-3 —
  // lift selectVolatileBeliefs' default maxResults cap (we filter to matchedKeys below).
  const volatileArgs = {
    maxResults: Math.max(1, provenance.length),
    now: opts.now,
    ...(opts.recentDays !== undefined ? { recentDays: opts.recentDays } : {})
  };
  const volatile = new Set(selectVolatileBeliefs(provenance, volatileArgs).map((b) => norm(b.key)));
  const out = new Set<string>();
  for (const key of matchedKeys) {
    if (volatile.has(norm(key))) out.add(key);
  }
  return out;
}

/**
 * Matched facts whose `lastConfirmed` is old enough to be {@link classifyFactFreshness}
 * `"stale"` — surfaced at POINT-OF-USE so a grounded answer cautions the value may be
 * out of date instead of asserting a months-old auto-fact as confident truth. Reuses
 * {@link classifyFactFreshness}'s threshold (no inlined cutoff). A key with NO provenance
 * entry, or an unparseable `lastConfirmed`, is NOT stale (fail-soft — never nag on
 * missing/bad data). Mirrors {@link contestedFactKeys}: keys compared through the
 * injected `normalizeKey`, the ORIGINAL matched key returned for the caller's lookup.
 * Pure.
 */
export function staleFactKeys(
  matchedKeys: readonly string[],
  provenance: readonly FactProvenance[],
  opts: { readonly now: number; readonly staleDays?: number; readonly normalizeKey?: (key: string) => string }
): ReadonlySet<string> {
  const norm = opts.normalizeKey ?? ((key: string): string => key);
  const stale = new Set<string>();
  for (const p of provenance) {
    const freshness = classifyFactFreshness(
      opts.staleDays !== undefined
        ? { lastConfirmed: p.lastConfirmed, now: opts.now, staleDays: opts.staleDays }
        : { lastConfirmed: p.lastConfirmed, now: opts.now }
    );
    if (freshness === "stale") stale.add(norm(p.key));
  }
  const out = new Set<string>();
  for (const key of matchedKeys) {
    if (stale.has(norm(key))) out.add(key);
  }
  return out;
}

/** A belief the auto-extractor keeps giving different values for — the user should
 *  confirm which is right (which promotes it to durable user-source). */
export interface VolatileBelief {
  readonly key: string;
  readonly kind: "fact" | "preference";
  readonly currentValue: string;
  readonly distinctValueCount: number;
}

/**
 * The user-remediable side of the volatility signal: the recently-active AUTO beliefs
 * whose value the extractor FLIPPED (`distinctValueCount >= minDistinctValues`) — the
 * recap nudges the user to confirm the current value, which re-states it as
 * user-source and promotes it to durable. A USER-stated belief is excluded (the user's
 * latest is already their deliberate truth, no confirmation needed). Most-volatile
 * first; capped. Pure.
 */
export function selectVolatileBeliefs(
  provenance: readonly FactProvenance[],
  opts: { readonly now: number; readonly recentDays?: number; readonly minDistinctValues?: number; readonly maxResults?: number }
): readonly VolatileBelief[] {
  const recentMs = Math.max(1, opts.recentDays ?? DEFAULT_FACT_STALE_DAYS) * 86_400_000;
  const minDistinct = Math.max(2, Math.trunc(opts.minDistinctValues ?? 2));
  const max = Math.max(1, Math.trunc(opts.maxResults ?? 3));
  return provenance
    .filter((p) => p.source === "auto" && p.distinctValueCount >= minDistinct)
    .filter((p) => {
      const age = opts.now - Date.parse(p.lastConfirmed);
      return Number.isFinite(age) && age <= recentMs;
    })
    .slice()
    .sort((a, b) => b.distinctValueCount - a.distinctValueCount)
    .slice(0, max)
    .map((p) => ({ currentValue: p.value, distinctValueCount: p.distinctValueCount, key: p.key, kind: p.kind }));
}

export interface RecentlyLearnedFact {
  readonly key: string;
  readonly kind: "fact" | "preference";
  readonly value: string;
  /** ISO timestamp Muse first learned this key. */
  readonly firstSeen: string;
  /** `user` = you stated it; `auto` = Muse inferred it (correctable). */
  readonly source: "auto" | "user";
}

/**
 * The facts Muse learned for the FIRST time within a recency window — the
 * other half of "recently learned about you". The factHistory projection only
 * catches CHANGES (a key with a prior value); a brand-new fact records no
 * supersession, so it would never surface there. This selects keys whose
 * `firstSeen` is within the window AND that have stayed STABLE
 * (`distinctValueCount === 1`) — a changed/flip-flopping key is the
 * supersession/volatile signal, not a first-learning, so it's excluded (no
 * double-count). Newest-first; capped. Pure — the code selects, citing the
 * recorded firstSeen, never the model.
 */
export function selectRecentlyLearnedFacts(
  provenance: readonly FactProvenance[],
  opts: { readonly now: number; readonly withinDays?: number; readonly maxResults?: number }
): readonly RecentlyLearnedFact[] {
  const windowMs = Math.max(1, opts.withinDays ?? DEFAULT_FACT_STALE_DAYS) * 86_400_000;
  const max = Math.max(1, Math.trunc(opts.maxResults ?? 5));
  return provenance
    .filter((p) => p.distinctValueCount === 1)
    .filter((p) => {
      const age = opts.now - Date.parse(p.firstSeen);
      return Number.isFinite(age) && age >= 0 && age <= windowMs;
    })
    .slice()
    .sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen))
    .slice(0, max)
    .map((p) => ({ firstSeen: p.firstSeen, key: p.key, kind: p.kind, source: p.source, value: p.value }));
}

/**
 * Render a first-learning as ONE cited, attribution-bearing line — "home city:
 * Busan (you told me · 2026-06-20)" vs "(I noticed · …)". The attribution is the
 * recorded provenance `source`: a USER-stated fact is your deliberate truth; an
 * `auto` one is Muse's inference, which you can correct. Honest about HOW it was
 * learned, not just WHAT. Pure; the date is the recorded firstSeen.
 */
export function formatFirstLearned(fact: RecentlyLearnedFact): string {
  const attribution = fact.source === "user" ? "you told me" : "I noticed";
  return `${fact.key.replace(/_/gu, " ")}: ${fact.value} (${attribution} · ${fact.firstSeen.slice(0, 10)})`;
}

export interface RecentlyForgotten {
  readonly key: string;
  /** ISO timestamp of the retraction — when you had Muse forget this. */
  readonly forgottenAt: string;
}

/**
 * Keys Muse FORGOT at your correction within a recency window — the other half
 * of "Learns you": the identity's promise is that it forgets the moment you
 * correct it, and this makes that visible. A key qualifies when its NEWEST
 * provenance event is a retraction (an explicit `forget`) inside the window; a
 * later re-`set` clears it (same newest-event rule as keysWithActiveRetraction),
 * so a re-learned key never shows as forgotten. Newest-first; capped. Pure +
 * cited (the recorded retraction timestamp); the code selects, never the model.
 */
export function selectRecentlyForgotten(
  entries: readonly BeliefProvenance[],
  opts: { readonly now: number; readonly withinDays?: number; readonly maxResults?: number }
): readonly RecentlyForgotten[] {
  const windowMs = Math.max(1, opts.withinDays ?? DEFAULT_FACT_STALE_DAYS) * 86_400_000;
  const max = Math.max(1, Math.trunc(opts.maxResults ?? 5));
  const newestByKey = new Map<string, BeliefProvenance>();
  for (const e of entries) {
    const prev = newestByKey.get(e.key);
    if (!prev || Date.parse(e.learnedAt) >= Date.parse(prev.learnedAt)) {
      newestByKey.set(e.key, e);
    }
  }
  const out: RecentlyForgotten[] = [];
  for (const [key, newest] of newestByKey) {
    if (newest.retraction !== true) {
      continue;
    }
    const age = opts.now - Date.parse(newest.learnedAt);
    if (!Number.isFinite(age) || age < 0 || age > windowMs) {
      continue;
    }
    out.push({ forgottenAt: newest.learnedAt, key });
  }
  return out.sort((a, b) => Date.parse(b.forgottenAt) - Date.parse(a.forgottenAt)).slice(0, max);
}

export interface BeliefValueStep {
  readonly value: string;
  /** ISO timestamp this value was first recorded (the change point). */
  readonly learnedAt: string;
}

/**
 * The CHANGE path a belief's value took, oldest→newest — "Seoul (2026-06-10) →
 * Busan (2026-06-20)". Built from the recorded provenance entries for the key
 * (retractions excluded — they carry no value); consecutive re-confirmations of
 * the SAME value collapse, so only genuine changes appear. A stable belief
 * yields one step. The deepest "show your work": not just "changed 2×" but the
 * actual values and when. Pure + cited (each step is a recorded entry); the code
 * builds it, never the model.
 */
export function beliefValueTimeline(entries: readonly BeliefProvenance[], key: string): readonly BeliefValueStep[] {
  const sorted = entries
    .filter((e) => e.key === key && e.retraction !== true)
    .slice()
    .sort((a, b) => Date.parse(a.learnedAt) - Date.parse(b.learnedAt));
  const out: BeliefValueStep[] = [];
  for (const e of sorted) {
    const prev = out[out.length - 1];
    if (!prev || prev.value.trim().toLowerCase() !== e.value.trim().toLowerCase()) {
      out.push({ learnedAt: e.learnedAt, value: e.value });
    }
  }
  return out;
}

export function defaultBeliefProvenanceFile(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MUSE_BELIEF_PROVENANCE_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const injectedHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return join(injectedHome && injectedHome.length > 0 ? injectedHome : homedir(), ".muse", "belief-provenance.json");
}

/** Format-only check (no decrypt): is the belief-provenance store encrypted at rest? */
export async function isBeliefProvenanceEncrypted(file: string): Promise<boolean> {
  try {
    return isEncryptedMemoryEnvelope(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return false;
  }
}

export async function readBeliefProvenance(file: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly BeliefProvenance[]> {
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
    await quarantineCorruptFile(file);
    return [];
  }
  // Decrypt if encrypted at rest. decryptMemoryEnvelope THROWS on a wrong key — fail
  // CLOSED (the read fails loudly, never silently returns []/plaintext). Only a
  // decrypted-but-not-JSON inner degrades to empty (a corrupt store, not a key mismatch).
  if (isEncryptedMemoryEnvelope(parsed)) {
    const plaintext = decryptMemoryEnvelope(parsed, env);
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      // The key authenticated successfully, so this is not a wrong-key case:
      // preserve the damaged envelope before a later append would otherwise
      // replace it with an empty fresh history.
      await quarantineCorruptFile(file);
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    await quarantineCorruptFile(file);
    return [];
  }
  return (parsed as { entries: unknown[] }).entries.flatMap((entry): readonly BeliefProvenance[] =>
    isBeliefProvenance(entry) ? [entry] : []
  );
}

export async function writeBeliefProvenance(file: string, entries: readonly BeliefProvenance[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Format-preserving: once encrypted, stays encrypted (so a record-after-encrypt
  // doesn't silently revert the user's facts-provenance to plaintext); plaintext stays
  // plaintext until the user encrypts. Same proven per-store pattern as user-memory.
  const serialized = JSON.stringify({ entries }, null, 2);
  const payload = await isBeliefProvenanceEncrypted(file)
    ? `${JSON.stringify(encryptMemoryEnvelope(serialized, env), null, 2)}\n`
    : `${serialized}\n`;
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
  constructor(private readonly file: string = defaultBeliefProvenanceFile(), private readonly env: NodeJS.ProcessEnv = process.env) {}

  async record(entry: BeliefProvenance): Promise<void> {
    await this.recordMany([entry]);
  }

  async recordMany(entries: readonly BeliefProvenance[]): Promise<void> {
    if (entries.length === 0) return;
    await this.serializeWrite(async () => {
      const existing = await readBeliefProvenance(this.file, this.env);
      const seen = new Set(existing.map(provenanceEventIdentity));
      const novel = entries.filter((entry) => {
        const identity = provenanceEventIdentity(entry);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
      if (novel.length === 0) return;
      const next = [...existing, ...novel].slice(-MAX_BELIEF_PROVENANCE_ENTRIES);
      await writeBeliefProvenance(this.file, next, this.env);
    });
  }

  async query(userId: string, key?: string): Promise<readonly BeliefProvenance[]> {
    const all = await readBeliefProvenance(this.file, this.env);
    const scoped = all.filter((e) => e.userId === userId && (key === undefined || e.key === key));
    return [...scoped].sort(compareNewestFirst);
  }

  async recordOwnerKeepResolution(input: {
    readonly createdAt: string;
    readonly exactId: string;
    readonly expectedVersion: number;
    readonly key: string;
    readonly kind: "fact" | "preference";
    readonly requestId: string;
    readonly userId: string;
    readonly value: string;
  }): Promise<BeliefProvenance> {
    if (
      !/^mem_v1_[a-f0-9]{32}$/u.test(input.exactId)
      || !Number.isSafeInteger(input.expectedVersion)
      || input.expectedVersion < 1
      || input.requestId.trim().length < 8
      || input.requestId.length > 128
      || /[\u0000-\u001f\u007f]/u.test(input.requestId)
      || !Number.isFinite(Date.parse(input.createdAt))
    ) {
      throw new BeliefProvenanceResolutionError("invalid-request", "invalid owner keep resolution");
    }
    return this.serializeWrite(async () => {
      const inspection = await inspectBeliefProvenanceSource(this.file, this.env);
      const existing = inspection.result === "absent"
        ? []
        : inspection.result === "available" && inspection.value.excludedCount === 0
          ? inspection.value.entries
          : undefined;
      if (!existing) {
        throw new BeliefProvenanceResolutionError(
          "invalid-request",
          "belief provenance authority is unreadable or contains excluded records"
        );
      }
      const replay = existing.find((entry) =>
        entry.userId === input.userId
        && entry.ownerResolution?.requestId === input.requestId
      );
      if (replay) {
        const resolution = replay.ownerResolution!;
        if (
          replay.key !== input.key
          || replay.kind !== input.kind
          || replay.value !== input.value
          || resolution.action !== "keep"
          || resolution.exactId !== input.exactId
          || resolution.expectedVersion !== input.expectedVersion
        ) {
          throw new BeliefProvenanceResolutionError(
            "request-reused",
            "keep request ID was already used for a different memory target or value"
          );
        }
        return replay;
      }
      const entry: BeliefProvenance = {
        key: input.key,
        kind: input.kind,
        learnedAt: input.createdAt,
        ownerResolution: {
          action: "keep",
          exactId: input.exactId,
          expectedVersion: input.expectedVersion,
          requestId: input.requestId
        },
        source: "user",
        userId: input.userId,
        value: input.value
      };
      const next = [...existing, entry].slice(-MAX_BELIEF_PROVENANCE_ENTRIES);
      await writeBeliefProvenance(this.file, next, this.env);
      return entry;
    });
  }

  private async serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    return withFileMutationQueue(this.file, () => withFileLock(this.file, operation));
  }
}

function provenanceEventIdentity(entry: BeliefProvenance): string {
  if (entry.ownerResolution) {
    return JSON.stringify([
      "owner-resolution",
      entry.userId,
      entry.key,
      entry.kind,
      entry.value,
      entry.ownerResolution.action,
      entry.ownerResolution.exactId,
      entry.ownerResolution.expectedVersion,
      entry.ownerResolution.requestId
    ]);
  }
  return JSON.stringify([
    entry.userId,
    entry.key,
    entry.kind,
    entry.value,
    entry.learnedAt,
    entry.sessionId ?? null,
    entry.evidenceExcerpt ?? null,
    entry.source ?? null,
    entry.retraction ?? false,
    null
  ]);
}

function isBeliefProvenance(value: unknown): value is BeliefProvenance {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<BeliefProvenance>;
  if (typeof e.userId !== "string" || e.userId.length === 0) return false;
  if (typeof e.key !== "string" || e.key.length === 0) return false;
  if (e.kind !== "fact" && e.kind !== "preference") return false;
  if (typeof e.value !== "string") return false;
  if (
    typeof e.learnedAt !== "string"
    || e.learnedAt.length === 0
    || !Number.isFinite(Date.parse(e.learnedAt))
  ) return false;
  if (e.sessionId !== undefined && typeof e.sessionId !== "string") return false;
  if (e.evidenceExcerpt !== undefined && typeof e.evidenceExcerpt !== "string") return false;
  if (e.source !== undefined && e.source !== "auto" && e.source !== "user") return false;
  if (e.retraction !== undefined && typeof e.retraction !== "boolean") return false;
  if (e.ownerResolution !== undefined) {
    const resolution = e.ownerResolution;
    if (!resolution || typeof resolution !== "object") return false;
    if (resolution.action !== "keep") return false;
    if (!/^mem_v1_[a-f0-9]{32}$/u.test(resolution.exactId)) return false;
    if (!Number.isSafeInteger(resolution.expectedVersion) || resolution.expectedVersion < 1) return false;
    if (
      typeof resolution.requestId !== "string"
      || resolution.requestId.trim().length < 8
      || resolution.requestId.length > 128
      || /[\u0000-\u001f\u007f]/u.test(resolution.requestId)
    ) return false;
    if (e.source !== "user" || e.retraction === true) return false;
  }
  return true;
}
