import { cosineSimilarity, lexicalOverlap, lexicalTokens } from "@muse/agent-core";
import type { Contact } from "@muse/mcp";

/**
 * SB-1: rank past-session episode summaries against the query so `muse ask`
 * grounds on the user's own history, not just notes. Pure + cosine-based;
 * caller supplies the already-embedded query vector. Top-K, descending score.
 */
const EPISODE_IMPORTANCE_WEIGHT = 0.15;
const EPISODE_RECENCY_WEIGHT = 0.15;
const EPISODE_RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/**
 * Recency component of the Generative Agents retrieval score (arXiv
 * 2304.03442): an exponential decay over the episode's age, 1.0 for a
 * just-ended session and halving every `EPISODE_RECENCY_HALF_LIFE_DAYS`.
 * Returns 0 when there's no usable timestamp (backward-compatible: an
 * episode with no `endedAt` adds no recency bump). A future timestamp is
 * clamped to age 0 so a skewed clock can't inflate the score past 1.
 */
function episodeRecencyScore(endedAt: string | undefined, nowMs: number): number {
  if (!endedAt) {
    return 0;
  }
  const t = Date.parse(endedAt);
  if (!Number.isFinite(t)) {
    return 0;
  }
  const ageDays = Math.max(0, (nowMs - t) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / EPISODE_RECENCY_HALF_LIFE_DAYS);
}

export function rankEpisodeHits(
  queryVec: readonly number[],
  episodes: ReadonlyArray<{ readonly id: string; readonly summary: string; readonly embedding: readonly number[]; readonly importance?: number; readonly endedAt?: string }>,
  topK: number,
  nowMs: number = Date.now()
): Array<{ id: string; summary: string; score: number }> {
  if (topK <= 0) {
    return [];
  }
  // Generative Agents (arXiv 2304.03442) ranks memories by relevance +
  // importance + RECENCY. Relevance is the cosine; importance and recency are
  // small bounded ADDITIVE bumps, so among similar-relevance episodes the more
  // important / more recent one wins, while an unscored, timestamp-less corpus
  // still ranks exactly by cosine as before (both bumps are 0).
  return episodes
    .map((ep) => {
      const importance = typeof ep.importance === "number" && Number.isFinite(ep.importance)
        ? Math.min(10, Math.max(1, ep.importance))
        : 0;
      const importanceBump = importance === 0 ? 0 : EPISODE_IMPORTANCE_WEIGHT * (importance / 10);
      const recencyBump = EPISODE_RECENCY_WEIGHT * episodeRecencyScore(ep.endedAt, nowMs);
      return { id: ep.id, score: cosineSimilarity(queryVec, ep.embedding) + importanceBump + recencyBump, summary: ep.summary };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}


export interface MemoryFact {
  readonly key: string;
  readonly value: string;
}

/**
 * EVERY askable remembered fact (facts + plain preferences; the internal `veto:`
 * / `goal:` slots are persona machinery). buildMusePersona lists ALL of these to
 * the model, so it can cite ANY — they are therefore ALL the citation gate's
 * allowed memory sources AND the verdict's evidence, regardless of which the
 * current query lexically matched (a query "allergic" needn't token-match a fact
 * keyed `allergy_penicillin` for the model — which has it from the persona — to
 * cite it honestly).
 */
export function allUserMemoryFacts(
  memory: { readonly facts: Readonly<Record<string, string>>; readonly preferences: Readonly<Record<string, string>> }
): readonly MemoryFact[] {
  return [
    ...Object.entries(memory.facts ?? {}),
    ...Object.entries(memory.preferences ?? {}).filter(([key]) => !key.startsWith("veto:") && !key.startsWith("goal:"))
  ].map(([key, value]) => ({ key, value }));
}

/**
 * Render a remembered fact as a NATURAL phrase for the model + judge: facts are
 * auto-extracted under machine keys with boolean-ish values (`allergy_penicillin:
 * "yes"`), which the small re-verify judge can't connect to "allergic to
 * penicillin". Underscore-join the key into words and drop a bare yes/true value
 * so the evidence reads as the topic itself ("allergy penicillin"); a real value
 * is kept ("favorite color: blue").
 */
export function renderMemoryFact(fact: MemoryFact): string {
  const topic = fact.key.replace(/[_-]+/gu, " ").trim();
  const value = fact.value.trim();
  return value === "" || /^(?:yes|true)$/iu.test(value) ? topic : `${topic}: ${value}`;
}

/**
 * The remembered facts most relevant to the question — token overlap on
 * `key value`. Used to EMPHASISE the on-topic facts in their own grounding block
 * (with the `[memory: <topic>]` hint); the gate/verdict still allow the full set.
 */
export function selectMemoryFacts(
  memory: { readonly facts: Readonly<Record<string, string>>; readonly preferences: Readonly<Record<string, string>> },
  queryTokens: ReadonlySet<string>,
  max = 5
): readonly MemoryFact[] {
  if (queryTokens.size === 0) {
    return [];
  }
  return allUserMemoryFacts(memory)
    .map((fact) => ({ fact, score: lexicalOverlap(queryTokens as Set<string>, `${fact.key} ${fact.value}`) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((scored) => scored.fact);
}

const BIRTHDAY_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/**
 * Render a contact's stored birthday (`MM-DD` or `YYYY-MM-DD`) as a readable
 * "March 14" (+ ", 1990" when a year is present) so `muse ask` can ground
 * "when is X's birthday?" on it. Returns undefined for an absent / malformed
 * value (no fabricated date).
 */
export function formatContactBirthday(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const match = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/u.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  const label = `${BIRTHDAY_MONTHS[month - 1] ?? ""} ${day.toString()}`;
  return match[1] ? `${label}, ${match[1]}` : label;
}

/**
 * The grounding-EVIDENCE text for a matched contact — the contact's name plus
 * EVERY field the prompt block renders: relationship/role (P37-20), connections/
 * edges (P37-21), email/phone/handle/birthday/aliases. The grounding rubric scores
 * an answer's coverage against this; if a field the model can answer from (a role,
 * an edge) is rendered in the block but MISSING here, a correct "your manager is
 * Dana" / "Bob works with Alice" answer scores ~zero coverage and false-flags
 * "unverified". So this MUST mirror the block render. Only REAL contact data, so a
 * fabricated role/edge stays uncovered → still flagged.
 */
export function contactGroundingEvidence(contact: Contact): string {
  const connections = (contact.connections ?? []).map((e) => `${e.as ?? "connected to"} ${e.to}`);
  const fields = [
    contact.relationship,
    contact.email,
    contact.phone,
    contact.handle,
    formatContactBirthday(contact.birthday),
    ...(contact.aliases ?? []),
    ...connections,
    contact.about
  ].filter((f): f is string => typeof f === "string" && f.length > 0).join(" ");
  return `${contact.name} ${fields}`.trim();
}

/**
 * Relevance of a contact to the question, for `muse ask` grounding (B3
 * perception): how many query tokens match a token of the contact's name,
 * aliases, handle, or email. 0 ⇒ NOT injected — so we ground only on the people
 * the question is actually about, never dump the whole address book at the
 * small local model.
 */
export function contactMatchScore(contact: Contact, queryTokens: ReadonlySet<string>): number {
  if (queryTokens.size === 0) {
    return 0;
  }
  const hay = new Set<string>();
  const add = (text: string | undefined): void => {
    if (text) {
      for (const tok of lexicalTokens(text)) {
        hay.add(tok);
      }
    }
  };
  add(contact.name);
  add(contact.handle);
  add(contact.email);
  add(contact.relationship);
  add(contact.about);
  for (const alias of contact.aliases ?? []) {
    add(alias);
  }
  let score = 0;
  for (const tok of queryTokens) {
    if (hay.has(tok)) {
      score += 1;
    }
  }
  return score;
}
