import { lexicalTokens, type KnowledgeMatch } from "./knowledge-recall.js";
import { splitPreservingSentencePunctuation } from "./internals.js";

/**
 * ALCE citation RECALL (arXiv:2305.14627) — the complement to citation precision.
 * Precision asks "is the cited source right?"; recall asks "does every groundable
 * claim actually CARRY a citation?" A sentence whose claim IS in the retrieved
 * evidence but that omits its `[from <source>]` marker is an UNCITED-but-citable
 * claim — it passes every existing gate silently (sentence-groundedness measures
 * union support but is citation-agnostic; precision only judges the citations that
 * ARE present). This localises the missing attributions. Diagnostic — changes no
 * gate verdict (mirrors sentence-groundedness / citation-precision). Pure.
 */
export interface CitationRecallReport {
  /** Sentences whose claim is supported by the union of evidence (≥ floor) — i.e. citable. */
  readonly citableCount: number;
  /** Of the citable sentences, how many actually carry a `[from <source>]` marker. */
  readonly citedCount: number;
  /** Fraction of citable sentences that carry a citation. 1 when nothing is citable. */
  readonly recall: number;
  /** Citable sentences that omit a citation (the missing attributions). */
  readonly uncited: readonly string[];
}

/** A sentence counts as citable when ≥ this fraction of its content tokens are in the evidence union. */
export const DEFAULT_CITATION_RECALL_FLOOR = 0.5;

const CITATION_FROM_RE = /\[from\s+([^\]]+?)\s*\]/giu;
// Private-use sentinel so a `[from x.md]` marker's internal "." can't split a
// sentence; its presence in a masked sentence marks "this sentence was cited".
const SENTINEL = "\u{E000}";
const SENTINEL_RE = /\u{E000}\d+\u{E000}/gu;

// A sentence where Muse declares it LACKS the asked-for info (an abstention) is the
// opposite of a groundable claim — it asserts ABSENCE, not a fact. Its tokens ("time",
// "appointment") can still overlap the broad evidence union (tasks/reminders) and look
// "citable", but flagging an honest "I don't have that" as a missing-citation claim
// punishes the very behavior the grounding edge wants (abstain over fabricate). So
// abstention sentences are excluded from the citable set. EN + KO self-knowledge negation.
const ABSTENTION_EN_RE = /\b(i\s+(do\s+not|don'?t|cannot|can'?t|could\s+not|couldn'?t|am\s+not)\s+(have|find|see|know|recall|locate|sure|certain|aware)|i'?m\s+not\s+(sure|certain|aware|able)|i'?m\s+afraid\s+i\s+(do\s+not|don'?t|cannot|can'?t)|there\s+(is|are)\s+no\b|no\s+[\w''-]+(\s+[\w''-]+){0,4}\s+(is|are|was|were)?\s*(listed|recorded|found|noted|mentioned|available)|not\s+(in\s+your\s+(notes|records|memory|context)|listed|recorded|available|specified))/iu;
const ABSTENTION_KO_RE = /(없(습니다|어요|네요|음|다|고)|모르(겠|겠습니다|ㄴ다)|확실하지\s*않|찾을\s*수\s*없|기록에\s*(는\s*)?없|정보가\s*없)/u;

/** True when a sentence is an ABSTENTION — Muse stating it lacks/can't find/isn't sure of the info. */
export function isAbstentionSentence(sentence: string): boolean {
  return ABSTENTION_EN_RE.test(sentence) || ABSTENTION_KO_RE.test(sentence);
}

/**
 * Remove `[from <source>]` citation markers from an answer — they are Muse's own
 * attribution metadata, not claims, and their internal "." (e.g. `.md]`) would
 * otherwise split into a junk sentence that a per-sentence groundedness probe
 * scores unsupported (an observed misgrounding false positive). Pure.
 */
export function stripCitationMarkers(text: string): string {
  return text.replace(CITATION_FROM_RE, " ");
}

export function reportCitationRecall(
  answer: string,
  matches: readonly KnowledgeMatch[],
  floor?: number
): CitationRecallReport {
  const effectiveFloor =
    typeof floor === "number" && Number.isFinite(floor) && floor > 0 ? floor : DEFAULT_CITATION_RECALL_FLOOR;

  const evidenceTokens = new Set<string>();
  for (const match of matches) {
    for (const token of lexicalTokens(match.text)) evidenceTokens.add(token);
  }

  let counter = 0;
  const masked = answer.replace(CITATION_FROM_RE, () => ` ${SENTINEL}${(counter++).toString()}${SENTINEL} `);

  let citableCount = 0;
  let citedCount = 0;
  const uncited: string[] = [];

  for (const sentenceMasked of splitPreservingSentencePunctuation(masked)) {
    const hasCitation = sentenceMasked.includes(SENTINEL);
    const sentence = sentenceMasked.replace(SENTINEL_RE, " ").replace(/\s+/gu, " ").trim();
    const tokens = lexicalTokens(sentence);
    if (tokens.size === 0) continue;
    let covered = 0;
    for (const token of tokens) {
      if (evidenceTokens.has(token)) covered += 1;
    }
    const citable = covered / tokens.size >= effectiveFloor;
    if (!citable || isAbstentionSentence(sentence)) continue;
    citableCount += 1;
    if (hasCitation) citedCount += 1;
    else uncited.push(sentence);
  }

  const recall = citableCount === 0 ? 1 : citedCount / citableCount;
  return { citableCount, citedCount, recall, uncited };
}
