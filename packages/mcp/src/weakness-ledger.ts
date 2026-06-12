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
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export const MAX_WEAKNESS_ENTRIES = 2000;

export type WeaknessAxis = "grounding-gap" | "unbacked-action" | "wrong-tool" | "time-parse" | "other";

export interface WeaknessEntry {
  readonly axis: WeaknessAxis;
  /** A short, normalised topic cluster key derived from the user's message. */
  readonly topic: string;
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** A remediation hint (populated by later Whetstone slices). */
  readonly hint?: string;
}

// Drop conversational filler so the topic key keeps only the salient nouns —
// "what's my office VPN MTU?" → "office vpn mtu", "내 오피스 vpn mtu 뭐야" → the same
// content words. KO particles are stripped by the token regex; these are the
// stand-alone filler words.
const STOPWORDS = new Set([
  "the", "a", "an", "my", "your", "is", "are", "do", "does", "did", "what", "whats", "what's",
  "who", "when", "where", "why", "how", "of", "for", "to", "in", "on", "about", "me", "i", "you",
  "please", "tell", "show", "give", "can", "could", "would", "and", "or", "그", "내", "제", "나",
  "너", "뭐", "뭐야", "무슨", "어떤", "누구", "언제", "어디", "왜", "어떻게", "해줘", "알려줘",
  "보여줘", "있어", "있나", "좀", "그리고", "또", "의", "을", "를", "은", "는", "이", "가", "에", "에서",
  "뭐였지", "뭐였어", "뭐지", "뭔지", "뭘까", "뭔가", "어딨", "어딨어", "있었", "이야", "인가"
]);

// Korean particles (조사) attach to a noun with no space — "일련번호가",
// "회의를", "학교에서" — so the same topic looks like a different token each
// time. Strip a trailing particle to cluster them, but ONLY when the remaining
// STEM is ≥ 2 chars, so a real word that merely ends in a particle syllable
// ("포도" → 도, "도서관" → 관-isn't-a-particle) is never truncated.
const KO_MULTI_PARTICLES = ["이라고", "으로", "에서", "에게", "한테", "까지", "부터", "라고", "처럼", "보다", "께서", "에다"];
const KO_SINGLE_PARTICLES = new Set(["은", "는", "이", "가", "을", "를", "의", "에", "도", "로", "와", "과", "만"]);

function stripKoreanParticle(token: string): string {
  if (!/[가-힣]/u.test(token)) {
    return token;
  }
  for (const particle of KO_MULTI_PARTICLES) {
    if (token.endsWith(particle) && token.length - particle.length >= 2) {
      return token.slice(0, -particle.length);
    }
  }
  if (token.length >= 3 && KO_SINGLE_PARTICLES.has(token.slice(-1))) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * A deterministic topic cluster key: NFC-normalise (the macOS desktop passes KO
 * args in NFD), lowercase, keep word/Hangul tokens, strip a trailing Korean
 * particle, drop filler, keep up to 4 salient tokens. Returns "" when nothing
 * salient remains (caller skips those).
 */
export function topicKeyFromMessage(message: string): string {
  const tokens = message
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .map(stripKoreanParticle)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
  return tokens.slice(0, 4).join(" ");
}

/**
 * Increment the matching `(axis, topic)` row's count + lastSeen, or insert a new
 * one. Returns a new array (input is not mutated).
 */
export function upsertWeakness(
  entries: readonly WeaknessEntry[],
  signal: { readonly axis: WeaknessAxis; readonly topic: string; readonly nowIso: string; readonly hint?: string }
): WeaknessEntry[] {
  const existing = entries.find((entry) => entry.axis === signal.axis && entry.topic === signal.topic);
  if (existing) {
    return entries.map((entry) =>
      entry === existing
        ? { ...entry, count: entry.count + 1, lastSeen: signal.nowIso, ...(signal.hint ? { hint: signal.hint } : {}) }
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
      ...(signal.hint ? { hint: signal.hint } : {})
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
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ weaknesses: bounded }, null, 2), "utf8");
}

/** A recurring weakness worth surfacing to the user as an actionable nudge. */
export interface RemediableWeakness {
  readonly topic: string;
  readonly count: number;
}

/**
 * The Whetstone REMEDIATION selector: pick the recurring `grounding-gap` topics
 * — the user asked about something Muse had no note for, repeatedly — so the
 * recap can nudge "add a note and I'll answer next time". Only `grounding-gap`
 * is surfaced: it is the axis the USER can fix (by adding a note); the other
 * axes (unbacked-action, wrong-tool, time-parse) are Muse's own bugs, not the
 * user's to remediate. Filters to count ≥ minCount, seen within recentDays;
 * most-asked first; capped. Pure.
 */
export function selectRemediableWeaknesses(
  entries: readonly WeaknessEntry[],
  opts: { readonly nowMs: number; readonly minCount?: number; readonly recentDays?: number; readonly maxResults?: number }
): readonly RemediableWeakness[] {
  const minCount = Math.max(2, Math.trunc(opts.minCount ?? 2));
  const recentMs = Math.max(1, opts.recentDays ?? 30) * 86_400_000;
  const max = Math.max(1, Math.trunc(opts.maxResults ?? 3));
  return entries
    .filter((entry) => entry.axis === "grounding-gap" && entry.count >= minCount)
    .filter((entry) => {
      const seen = Date.parse(entry.lastSeen);
      return Number.isFinite(seen) && opts.nowMs - seen <= recentMs;
    })
    .slice()
    .sort((a, b) => b.count - a.count || Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, max)
    .map((entry) => ({ count: entry.count, topic: entry.topic }));
}

export interface DevFixableWeakness {
  readonly topic: string;
  readonly axis: WeaknessAxis;
  readonly count: number;
}

/** The axes that are MUSE'S OWN bug to fix (not the user's to remediate with a note). */
const DEV_FIXABLE_AXES: ReadonlySet<WeaknessAxis> = new Set<WeaknessAxis>(["unbacked-action", "wrong-tool", "time-parse"]);

/**
 * The DEV-side mirror of {@link selectRemediableWeaknesses}: the recurring
 * weaknesses that are MUSE'S OWN bug, not the user's — unbacked-action (claimed
 * an action it didn't do), wrong-tool, time-parse. `grounding-gap` is excluded
 * (that one the USER fixes by adding a note; the recap nudges it). These are the
 * dev loop's fix targets — what the agent keeps getting wrong on its own.
 * Filters to count ≥ minCount; most-recurring first; capped. Pure.
 */
export function selectDevFixableWeaknesses(
  entries: readonly WeaknessEntry[],
  opts: { readonly minCount?: number; readonly maxResults?: number } = {}
): readonly DevFixableWeakness[] {
  const minCount = Math.max(2, Math.trunc(opts.minCount ?? 2));
  const max = Math.max(1, Math.trunc(opts.maxResults ?? 5));
  return entries
    .filter((entry) => DEV_FIXABLE_AXES.has(entry.axis) && entry.count >= minCount)
    .slice()
    .sort((a, b) => b.count - a.count || Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, max)
    .map((entry) => ({ axis: entry.axis, count: entry.count, topic: entry.topic }));
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
  const entries = await readWeaknesses(file);
  const next = upsertWeakness(entries, {
    axis: signal.axis,
    nowIso: signal.nowIso ?? new Date().toISOString(),
    topic,
    ...(signal.hint ? { hint: signal.hint } : {})
  });
  await writeWeaknesses(file, next);
  return next.find((entry) => entry.axis === signal.axis && entry.topic === topic);
}
