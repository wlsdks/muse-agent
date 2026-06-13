import { chunkText, cosineSimilarity, lexicalOverlap, lexicalTokens, rankPlaybookStrategies, renderPlaybookSection, type KnowledgeMatch } from "@muse/agent-core";
import type { ActionLogEntry, Contact } from "@muse/mcp";

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

/** Build the <<memory N>> grounding block from the on-topic remembered facts. Pure. */
export function buildMemoryContextBlock(facts: readonly MemoryFact[]): string {
  if (facts.length === 0) {
    return "(no matching remembered facts)";
  }
  return facts
    .map((f, i) => `<<memory ${(i + 1).toString()} — ${f.key}>>\n${renderMemoryFact(f)}\n[memory: ${f.key}]\n<<end>>`)
    .join("\n\n");
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

/**
 * Note evidence the grounding VERDICT scores against, augmented for the agent
 * (`--with-tools`) path. The chat-only path's `scored` top-K IS exactly what
 * grounded the answer; but the agent can pull a chunk via `knowledge_search`
 * (often on a reformulated query) that the CLI's pre-retrieval top-K missed, so
 * scoring the agent's answer against `scored` alone would false-flag a
 * legitimately grounded answer "treat as unverified". This adds the FULL text
 * of every note the answer actually CITES (each already gate-validated against
 * the live corpus) so a cited note is always covered. Additive only: it can
 * prevent a false "ungrounded", never cause a false "grounded" — a drifted
 * value that appears in no cited note still scores uncovered. Pure + exported.
 */
export function augmentNoteEvidenceWithCited(
  baseNotes: readonly KnowledgeMatch[],
  citedSources: readonly string[],
  liveNotes: readonly { readonly source: string; readonly chunks: readonly { readonly text: string }[] }[]
): KnowledgeMatch[] {
  const out: KnowledgeMatch[] = baseNotes.map((m) => ({ ...m }));
  const seen = new Set(out.map((m) => `${m.source} ${m.text}`));
  const cited = new Set(citedSources);
  for (const note of liveNotes) {
    if (!cited.has(note.source)) continue;
    for (const chunk of note.chunks) {
      const key = `${note.source} ${chunk.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ cosine: 1, score: 1, source: note.source, text: chunk.text });
    }
  }
  return out;
}

/**
 * Select the passages of an ad-hoc `--file` to ground on: split into passages,
 * rank by lexical overlap with the question (file order breaks ties), and keep
 * the strongest up to `charBudget` so a large file never blows the small
 * model's context. Returned in ORIGINAL file order (so the model reads them
 * top-to-bottom). A tiny file → every passage; an empty file → none.
 */
export function selectFilePassages(
  raw: string,
  query: string,
  charBudget = 6000
): readonly { readonly chunkIndex: number; readonly text: string }[] {
  const qTokens = lexicalTokens(query);
  const ranked = chunkText(raw, 1200)
    .map((text, chunkIndex) => ({ chunkIndex, ov: lexicalOverlap(qTokens, text), text }))
    .sort((a, b) => b.ov - a.ov || a.chunkIndex - b.chunkIndex);
  const picked: { chunkIndex: number; text: string }[] = [];
  let budget = charBudget;
  for (const passage of ranked) {
    if (budget <= 0) {
      break;
    }
    picked.push({ chunkIndex: passage.chunkIndex, text: passage.text });
    budget -= passage.text.length;
  }
  return picked.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

/**
 * The action-log entries most relevant to the question, for `muse ask`
 * transparency grounding ("did you send that? / what have you done?"). Matches
 * by query-token overlap against each entry's `what` text; newest-first on a
 * tie, capped. 0-overlap entries are dropped so an unrelated question grounds on
 * nothing (→ honest refusal). Pure + testable.
 */
export function selectGroundingActions(
  entries: readonly ActionLogEntry[],
  query: string,
  max = 5
): readonly ActionLogEntry[] {
  const queryTokens = lexicalTokens(query);
  if (queryTokens.size === 0) {
    return [];
  }
  return entries
    .map((entry, index) => ({ entry, index, score: lexicalOverlap(queryTokens, entry.what) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, max)
    .map((scored) => scored.entry);
}

/**
 * The most query-relevant PROBATION strategy (one the daemon distilled UNATTENDED
 * from a past correction — recorded but NEVER injected) to surface as a recall-time
 * suggestion, so a correction resurfaces the moment its topic recurs. Ranks the
 * probation entries by lexical overlap with the query; returns the top one, or
 * undefined when none is relevant. Pure (no injection — surface-only). Exported for
 * direct coverage.
 */
export function selectProbationSuggestion(
  entries: readonly { readonly id: string; readonly text: string; readonly probation?: boolean }[],
  query: string
): { readonly text: string; readonly id: string } | undefined {
  const queryToks = lexicalTokens(query);
  return entries
    .filter((e) => e.probation === true && typeof e.text === "string" && lexicalOverlap(queryToks, e.text) > 0)
    .sort((a, b) => lexicalOverlap(queryToks, b.text) - lexicalOverlap(queryToks, a.text))
    .map((e) => ({ id: e.id, text: e.text }))[0];
}

/**
 * ReasoningBank (arXiv 2509.25140): rank the playbook entries by relevance to
 * the current question and render only the top-K as `[Learned Strategies]`,
 * instead of dumping the whole bank at the small local model. Deterministic;
 * empty bank ⇒ undefined (no block).
 */
export function selectPlaybookSection(
  entries: readonly { readonly text: string; readonly tag?: string; readonly reward?: number; readonly reinforcements?: number; readonly decays?: number }[],
  queryText: string,
  topK?: number
): string | undefined {
  const ranked = rankPlaybookStrategies(
    entries.map((entry) => ({
      text: entry.text,
      ...(entry.tag ? { tag: entry.tag } : {}),
      ...(typeof entry.reward === "number" ? { reward: entry.reward } : {}),
      ...(typeof entry.reinforcements === "number" ? { reinforcements: entry.reinforcements } : {}),
      ...(typeof entry.decays === "number" ? { decays: entry.decays } : {})
    })),
    queryText,
    topK === undefined ? undefined : { topK }
  );
  return renderPlaybookSection(ranked);
}

/**
 * The single learned strategy that most shaped this answer — the top-ranked
 * injectable entry (S6 "I learned this about you"). Same ranking + exclusions as
 * `selectPlaybookSection` (avoided/probation never injected), so this is exactly
 * the strategy at the head of the `[Learned Strategies]` block. Undefined when
 * nothing injectable. The caller still gates the surfaced beat on real relevance
 * to the question, so a recency-floor pick never overclaims "applied".
 */
export function topAppliedStrategy(
  entries: readonly { readonly text: string; readonly tag?: string; readonly reward?: number; readonly probation?: boolean; readonly reinforcements?: number; readonly decays?: number }[],
  queryText: string,
  topK?: number
): string | undefined {
  const ranked = rankPlaybookStrategies(
    entries.map((entry) => ({
      text: entry.text,
      ...(entry.tag ? { tag: entry.tag } : {}),
      ...(typeof entry.reward === "number" ? { reward: entry.reward } : {}),
      ...(entry.probation ? { probation: true } : {}),
      ...(typeof entry.reinforcements === "number" ? { reinforcements: entry.reinforcements } : {}),
      ...(typeof entry.decays === "number" ? { decays: entry.decays } : {})
    })),
    queryText,
    topK === undefined ? undefined : { topK }
  );
  return ranked[0]?.text;
}
