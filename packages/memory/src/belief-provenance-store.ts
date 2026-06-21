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
 * {@link FactProvenance.distinctValueCount} into a FALSE volatility signal (the fire-16
 * over-count). Conservative: only a STRICT token-subset collapses, so a narrowing or a
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
 * Aggregate the append-only belief-provenance LOG into one record per key —
 * firstSeen (earliest learnedAt), lastConfirmed (latest), confirmCount, source
 * (`user` if any confirmation was user-stated — Hindsight: a user truth outranks an
 * auto-inference), and the value carried at the most-recent learnedAt. The data
 * already exists in the log; this DERIVES the per-fact signal a freshness/promotion
 * layer needs, with NO migration of the flat `facts` store. Pure.
 */
/**
 * Keys whose NEWEST belief-provenance event is a RETRACTION (an explicit user
 * `forget`) — so the auto-extractor must NOT resurface them. A later non-retraction
 * event (a deliberate re-`set` / re-learn the user authored) is newer, so the key
 * drops out (the user reopened it). Pure over the append-only log.
 */
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

/**
 * The durable-promotion gate (G4): which facts have EARNED durable trust. A
 * user-STATED fact is trusted immediately (the user typed it — Hindsight: a user
 * truth outranks an inference, and the latest is their current truth even if it
 * flipped); an AUTO-inferred fact must be re-confirmed `minConfirmCount` times AND
 * recently AND with a STABLE value (`distinctValueCount === 1`). H2: a high
 * confirmCount with the value FLIPPING (`distinctValueCount > 1`) is the auto-
 * extractor giving conflicting values for the key — re-confirmation of a CHANGING
 * belief, the opposite of stable truth — so it stays provisional until the user
 * confirms it. FAIL-CLOSE: a value the injection detector flags is NEVER promoted,
 * however often confirmed. The injection check is INJECTED (`isInjection`) so this
 * layer stays free of the agent-core dependency; the caller passes `isMemoryInjection`.
 * Pure.
 */
export function selectPromotableFacts(
  provenance: readonly FactProvenance[],
  opts: { readonly now: number; readonly minConfirmCount?: number; readonly recentDays?: number; readonly isInjection?: (value: string) => boolean }
): readonly PromotableFact[] {
  const minConfirm = Math.max(1, Math.trunc(opts.minConfirmCount ?? DEFAULT_PROMOTE_MIN_CONFIRM));
  const recentMs = Math.max(1, opts.recentDays ?? DEFAULT_PROMOTE_RECENT_DAYS) * 86_400_000;
  const isInjection = opts.isInjection ?? ((): boolean => false);
  const recent = (lastConfirmed: string): boolean => {
    const age = opts.now - Date.parse(lastConfirmed);
    return Number.isFinite(age) && age <= recentMs;
  };
  return provenance
    .filter((p) => !isInjection(p.value))
    .filter((p) => p.source === "user" || (p.confirmCount >= minConfirm && recent(p.lastConfirmed) && p.distinctValueCount === 1))
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
 * The user-remediable end of H2 (closes the loop): the recently-active AUTO beliefs
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
  if (e.source !== undefined && e.source !== "auto" && e.source !== "user") return false;
  return true;
}
