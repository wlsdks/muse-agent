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

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

export const MAX_WEAKNESS_ENTRIES = 2000;

// Bayesian Knowledge Tracing constants (arXiv:2105.00385, Badrinath/Wang/Pardos, pyBKT, EDM'21).
// P(L0)=prior, P(T)=learn, P(G)=guess, P(S)=slip, mastered threshold.
export const BKT_PRIOR = 0.1;
export const BKT_LEARN = 0.2;
export const BKT_GUESS = 0.2;
export const BKT_SLIP = 0.1;
export const WEAKNESS_MASTERED_AT = 0.95;

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

/**
 * BKT update: given the current mastery estimate and whether the observation was
 * a success, returns the updated P(known) after applying the observation and
 * the learning step (arXiv:2105.00385, Badrinath/Wang/Pardos, pyBKT, EDM'21).
 * Absent/NaN/out-of-range input coerces to BKT_PRIOR.
 */
export function bktUpdate(pKnown: number | undefined, observedSuccess: boolean): number {
  const pL = (typeof pKnown === "number" && Number.isFinite(pKnown) && pKnown >= 0 && pKnown <= 1)
    ? pKnown
    : BKT_PRIOR;
  const pLGivenObs = observedSuccess
    ? (pL * (1 - BKT_SLIP)) / (pL * (1 - BKT_SLIP) + (1 - pL) * BKT_GUESS)
    : (pL * BKT_SLIP) / (pL * BKT_SLIP + (1 - pL) * (1 - BKT_GUESS));
  const pLNext = pLGivenObs + (1 - pLGivenObs) * BKT_LEARN;
  return Math.min(1, Math.max(0, pLNext));
}

/**
 * Returns true when a weakness entry has been mastered (pKnown ≥ WEAKNESS_MASTERED_AT).
 * Legacy entries without pKnown are never mastered — they behave exactly as before.
 */
export function isMasteredWeakness(entry: WeaknessEntry): boolean {
  return typeof entry.pKnown === "number" && entry.pKnown >= WEAKNESS_MASTERED_AT;
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

/** A recurring weakness worth surfacing to the user as an actionable nudge. */
export interface RemediableWeakness {
  readonly topic: string;
  readonly count: number;
  readonly axis: WeaknessAxis;
}

/** The axes the USER fixes (not Muse's bug): a `grounding-gap` (add a note) or a
 *  `source-conflict` (their own saved notes disagree — reconcile them). */
const USER_REMEDIABLE_AXES: ReadonlySet<WeaknessAxis> = new Set<WeaknessAxis>(["grounding-gap", "source-conflict"]);

/**
 * The user-facing remediation action for a remediable weakness, per axis — the two
 * are DIFFERENT fixes: a `grounding-gap` means Muse has no note (add one), a
 * `source-conflict` means two of the user's OWN saved notes give different answers
 * (reconcile them). Single source of the copy so the recap renders each correctly.
 */
export function remediationHint(axis: WeaknessAxis, topic: string): string {
  return axis === "source-conflict"
    ? `your saved notes about "${topic}" disagree — reconcile them`
    : `add a note about "${topic}"`;
}

/**
 * The Whetstone REMEDIATION selector: pick the recurring topics the USER can fix —
 * a `grounding-gap` (asked about something Muse had no note for, repeatedly → add a
 * note) OR a `source-conflict` (the user's own saved notes disagree on a field →
 * reconcile them). Both are the user's to remediate, with DIFFERENT actions (see
 * {@link remediationHint}); the dev-fixable axes (misgrounding, unbacked-action,
 * wrong-tool, time-parse) are Muse's OWN bugs and are excluded here (they go to
 * {@link selectDevFixableWeaknesses}). Filters to count ≥ minCount, seen within
 * recentDays; most-asked first; capped. Pure.
 */
export function selectRemediableWeaknesses(
  entries: readonly WeaknessEntry[],
  opts: { readonly nowMs: number; readonly minCount?: number; readonly recentDays?: number; readonly maxResults?: number }
): readonly RemediableWeakness[] {
  const minCount = Math.max(2, Math.trunc(opts.minCount ?? 2));
  const recentMs = Math.max(1, opts.recentDays ?? 30) * 86_400_000;
  const max = Math.max(1, Math.trunc(opts.maxResults ?? 3));
  return entries
    .filter((entry) => USER_REMEDIABLE_AXES.has(entry.axis) && entry.count >= minCount && !isMasteredWeakness(entry))
    .filter((entry) => {
      const seen = Date.parse(entry.lastSeen);
      return Number.isFinite(seen) && opts.nowMs - seen <= recentMs;
    })
    .slice()
    .sort((a, b) => b.count - a.count || Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, max)
    .map((entry) => ({ axis: entry.axis, count: entry.count, topic: entry.topic }));
}

/** A point-of-use weakness nudge for the CURRENT ask's topic. */
export interface AskTimeNudge {
  readonly topic: string;
  readonly axis: WeaknessAxis;
  readonly count: number;
  readonly hint: string;
}

/**
 * Runtime learn→apply: when the CURRENT ask's topic is ALREADY a RECURRING
 * user-remediable weakness (count ≥ minRecurrence, not yet mastered), return the
 * remediation hint + count so the answer surfaces it AT THE MOMENT of the repeated
 * failure — closing the loop at runtime instead of only the once-a-day recap. A
 * DETERMINISTIC, USER-facing surfacing (never a model-steering prompt instruction).
 * Picks the most-recurring user-remediable axis for the topic. Pure.
 */
export function askTimeWeaknessNudge(
  entries: readonly WeaknessEntry[],
  topic: string,
  opts?: { readonly minRecurrence?: number }
): AskTimeNudge | undefined {
  const minRecurrence = Math.max(2, Math.trunc(opts?.minRecurrence ?? 2));
  const candidates = entries.filter(
    (entry) => entry.topic === topic && USER_REMEDIABLE_AXES.has(entry.axis) && entry.count >= minRecurrence && !isMasteredWeakness(entry)
  );
  if (candidates.length === 0) return undefined;
  const top = candidates.reduce((a, b) => (b.count > a.count ? b : a));
  return { axis: top.axis, count: top.count, hint: remediationHint(top.axis, top.topic), topic: top.topic };
}

/**
 * Localized, axis-aware sentence for an {@link askTimeWeaknessNudge} result — the
 * SINGLE source of the user-facing wording shared by every point-of-use surface
 * (the `ask` 💡 stderr cue AND the in-chat repeat nudge), so source-conflict vs
 * grounding-gap phrasing can never drift between them. Returns the bare sentence
 * (no leading glyph / parens) — each surface wraps it in its own format. Pure.
 */
export function renderAskTimeNudge(nudge: AskTimeNudge, ko: boolean): string {
  if (nudge.axis === "source-conflict") {
    return ko
      ? `"${nudge.topic}" 관련 노트가 서로 어긋나요 (${nudge.count.toString()}번째) — 정리해두시면 정확히 답해드릴게요.`
      : `your notes on "${nudge.topic}" disagree (${nudge.count.toString()}×) — reconcile them and I'll answer accurately`;
  }
  return ko
    ? `"${nudge.topic}" 주제는 전에도 막혔는데 노트에 없어요 (${nudge.count.toString()}번째) — 메모를 추가하시면 다음엔 답해드릴게요.`
    : `you've hit "${nudge.topic}" ${nudge.count.toString()}× and it's not in your notes — add one and I'll answer next time`;
}

export interface DevFixableWeakness {
  readonly topic: string;
  readonly axis: WeaknessAxis;
  readonly count: number;
}

/** The axes that are MUSE'S OWN bug to fix (not the user's to remediate with a note). */
const DEV_FIXABLE_AXES: ReadonlySet<WeaknessAxis> = new Set<WeaknessAxis>(["misgrounding", "unbacked-action", "wrong-tool", "time-parse"]);

/**
 * Axes a later GROUNDED SUCCESS on the same topic learns away (BKT mastery up): a
 * `grounding-gap` (couldn't answer → now can) and a `misgrounding` (answered but
 * unsupported → now grounded — the GROUNDED≠TRUE core failure). NOT a dev-fixable
 * actuator axis (time-parse/wrong-tool/unbacked-action), which is a code bug a grounded
 * Q&A can't fix. Making misgrounding resolvable closes the whetstone loop's core axis,
 * which was a one-way ratchet before (recordWeakness lowers mastery for all 7 axes, but
 * recordWeaknessResolved raised it for grounding-gap only).
 */
const GROUNDED_SUCCESS_RESOLVABLE_AXES: ReadonlySet<WeaknessAxis> = new Set<WeaknessAxis>(["grounding-gap", "misgrounding"]);

/**
 * The DEV-side mirror of {@link selectRemediableWeaknesses}: the recurring
 * weaknesses that are MUSE'S OWN bug, not the user's — misgrounding (cited a real
 * source that doesn't back the claim; GROUNDED != TRUE), unbacked-action (claimed
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
    // Mastery-aware (parity with selectRemediableWeaknesses): a topic Muse demonstrably
    // re-learned (BKT pKnown high via recordWeaknessResolved) drops off the doctor list —
    // else a fixed misgrounding topic nags `muse doctor` forever, eroding the self-eval signal.
    .filter((entry) => DEV_FIXABLE_AXES.has(entry.axis) && entry.count >= minCount && !isMasteredWeakness(entry))
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
    const existing = entries.find((e) => GROUNDED_SUCCESS_RESOLVABLE_AXES.has(e.axis) && e.topic === topic);
    if (!existing) {
      return undefined;
    }
    const resolvedAt = nowIso ?? new Date().toISOString();
    const updated: WeaknessEntry = {
      ...existing,
      pKnown: bktUpdate(existing.pKnown, true),
      lastResolved: resolvedAt
    };
    const next = entries.map((e) => (e === existing ? updated : e));
    await writeWeaknesses(file, next);
    return updated;
  });
}
