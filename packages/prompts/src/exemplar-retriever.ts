import { cleanBlock, compactSections } from "./prompt-text.js";

export interface ExemplarDocument {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly scenario: string;
  readonly body: string;
}

export interface ExemplarRetriever {
  retrieveTopK(userPrompt: string, k: number): string | Promise<string>;
}

export interface InMemoryExemplarRetrieverOptions {
  readonly fallback?: ExemplarRetriever;
  readonly headerPreamble?: string;
  readonly minScore?: number;
  readonly pinnedIds?: readonly string[];
  readonly topK?: number;
}

export const DEFAULT_EXEMPLAR_HEADER = "[Answer Quality Examples]";

export function parseExemplarMarkdown(markdown: string): readonly ExemplarDocument[] {
  const matches = [...markdown.matchAll(EXEMPLAR_HEADER_PATTERN)];

  if (matches.length === 0) {
    return [];
  }

  const documents: ExemplarDocument[] = [];
  const seenIds = new Set<string>();

  for (const [position, match] of matches.entries()) {
    if (match.index === undefined) {
      continue;
    }

    const next = matches[position + 1];
    const block = markdown.slice(match.index, next?.index ?? markdown.length).trim();
    const index = Number.parseInt(match[1] ?? "", 10);
    const rawTitle = (match[2] ?? "").trim();
    const scenario = SCENARIO_PATTERN.exec(block)?.[1]?.trim();

    if (!Number.isFinite(index) || !rawTitle || !scenario) {
      continue;
    }

    // `id` keyed off the human number stays `exemplar-N` for a
    // well-formed file, but two blocks can legitimately share a
    // number (a bilingual file with `[Example 1 …]` AND
    // `[예시 1 …]`). Suffix collisions with the parse position so
    // the second isn't silently dropped by id-dedup / unreachable
    // by pinnedIds.
    const baseId = `exemplar-${index}`;
    const id = seenIds.has(baseId) ? `${baseId}-${position}` : baseId;
    seenIds.add(id);

    documents.push({
      body: block,
      id,
      index,
      scenario,
      title: `[${match[0].slice(1, -1).trim()}]`
    });
  }

  return documents.sort((left, right) => left.index - right.index);
}

export class FullExemplarRetriever implements ExemplarRetriever {
  constructor(private readonly fullExemplarsContent: string) {}

  retrieveTopK(): string {
    return this.fullExemplarsContent;
  }
}

export class InMemoryExemplarRetriever implements ExemplarRetriever {
  private readonly documents: readonly ExemplarDocument[];
  private readonly fallback: ExemplarRetriever;
  private readonly headerPreamble: string;
  private readonly minScore: number;
  private readonly pinnedIds: readonly string[];
  private readonly topK: number;

  constructor(markdownOrDocuments: string | readonly ExemplarDocument[], options: InMemoryExemplarRetrieverOptions = {}) {
    this.documents = typeof markdownOrDocuments === "string"
      ? parseExemplarMarkdown(markdownOrDocuments)
      : [...markdownOrDocuments].sort((left, right) => left.index - right.index);
    this.fallback = options.fallback ?? new FullExemplarRetriever(
      typeof markdownOrDocuments === "string"
        ? markdownOrDocuments.trim()
        : renderExemplarDocuments(markdownOrDocuments, options.headerPreamble)
    );
    this.headerPreamble = cleanBlock(options.headerPreamble) ?? DEFAULT_EXEMPLAR_HEADER;
    this.minScore = Math.max(1, options.minScore ?? 1);
    this.pinnedIds = options.pinnedIds ?? [];
    this.topK = Math.max(1, options.topK ?? 3);
  }

  async retrieveTopK(userPrompt: string, k: number = this.topK): Promise<string> {
    const query = cleanBlock(userPrompt);
    const limit = Math.max(0, k);

    if (!query || limit <= 0) {
      return this.fallback.retrieveTopK(userPrompt, k);
    }

    const scored = this.documents
      .map((document) => ({ document, score: scoreExemplar(query, document) }))
      .filter((item) => item.score >= this.minScore)
      .sort((left, right) => {
        const score = right.score - left.score;
        return score !== 0 ? score : left.document.index - right.document.index;
      })
      .slice(0, limit)
      .map((item) => item.document);
    const pinned = this.pinnedIds
      .map((id) => this.documents.find((document) => document.id === id))
      .filter((document): document is ExemplarDocument => document !== undefined);

    if (scored.length === 0 && pinned.length === 0) {
      return this.fallback.retrieveTopK(userPrompt, k);
    }

    // A pinned id can also be a top scorer; without dedup the same
    // exemplar is rendered twice — wasted context + a degraded
    // few-shot signal. Scored order is kept; pins fill the gaps.
    const deduped: ExemplarDocument[] = [];
    const seen = new Set<string>();
    for (const document of [...scored, ...pinned]) {
      if (seen.has(document.id)) continue;
      seen.add(document.id);
      deduped.push(document);
    }

    return renderExemplarDocuments(deduped, this.headerPreamble);
  }
}

export function renderExemplarDocuments(documents: readonly ExemplarDocument[], headerPreamble = DEFAULT_EXEMPLAR_HEADER): string {
  const seen = new Set<string>();
  const bodies: string[] = [];

  for (const document of documents) {
    const body = cleanBlock(document.body);

    if (body && !seen.has(body)) {
      seen.add(body);
      bodies.push(body);
    }
  }

  return compactSections([headerPreamble, ...bodies]).join("\n\n");
}

function scoreExemplar(query: string, document: ExemplarDocument): number {
  const queryTokens = tokenSet(query);
  const haystack = tokenSet(`${document.title} ${document.scenario} ${document.body}`);
  let score = 0;

  for (const token of queryTokens) {
    if (haystack.has(token)) {
      score += 1;
    }
  }

  return score;
}

// Unambiguous function words that carry no topical signal. A query
// sharing only these with an exemplar (e.g. "what"/"the"/"do" or the
// Korean topic/subject/object particles) is NOT topically related —
// counting that overlap injects an off-topic few-shot into the small
// local window. Conservative by design: every entry is a pure function
// word, NEVER a content noun; when a Korean token is ambiguous it is
// left OUT so the filter can only drop noise, never a real term.
const EXEMPLAR_STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "can", "could", "would", "should", "will", "shall",
  "what", "which", "who", "whom", "when", "where", "why", "how",
  "about", "of", "to", "in", "on", "for", "and", "or", "but", "if",
  "with", "from", "into", "out", "this", "that", "these", "those",
  "i", "you", "he", "she", "it", "we", "they", "me", "my", "your",
  "not", "any", "all", "as", "at", "by", "so",
  // Korean particles / pro-form function words — unambiguous, never a noun.
  "은", "는", "이", "가", "을", "를", "도", "의", "에", "와", "과", "그", "어떻게"
]);

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/u)
      .map((token) => token.trim())
      // A single ASCII letter/digit is noise, but a single Hangul
      // syllable is a full content word (물=water, 책=book, 돈=money)
      // — Korean is a primary user language; dropping it silently
      // discarded the most salient term from exemplar scoring.
      .filter((token) => token.length >= 2 || /[가-힣]/u.test(token))
      // Additive on top of the length/Hangul rule: drop pure function
      // words so only content-word overlap scores an exemplar.
      .filter((token) => !EXEMPLAR_STOP_WORDS.has(token))
  );
}

const EXEMPLAR_HEADER_PATTERN = /\[(?:Example|예시)\s*(\d+)\s*[-\u2010-\u2015]\s*([^\]]+?)\]/gu;
const SCENARIO_PATTERN = /<scenario>(.*?)<\/scenario>/su;
