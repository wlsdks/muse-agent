import { verifyGrounding, type KnowledgeMatch } from "@muse/agent-core";

import { searchRecall, type RecallHit } from "./commands-recall.js";

// Per-turn grounding for the conversational surface (`muse chat`).
//
// The problem this closes: unlike `muse ask` — which pre-retrieves the
// user's notes BEFORE generating — plain chat sent the model only the
// persona + the current date, so a factual question about the user's OWN
// data ("what's the office VPN MTU?") was answered from the model's general
// knowledge. With a note saying 1380, chat confabulated "usually 1500
// bytes" — a fabrication-rate-=0 violation on the primary surface. The fix
// is retrieval-augmented chat: embed the turn, pull the most relevant note
// chunks, and inject them as an AUTHORITATIVE block so the answer is cited
// from the user's own data instead of invented.
//
// Deterministic where it counts: the retrieval + threshold are code (the
// small local Qwen never decides whether to ground), so the only
// model-dependent step is "use the passages you were handed", which the
// fact-framed wording below makes reliable on qwen3:8b.

// A hit must clear this cosine to be injected as authoritative context.
// Below it, nomic-embed similarities are topical noise — an off-corpus
// question would otherwise drag in loosely-related notes and the model
// would dutifully "answer" from an irrelevant snippet. Gating here keeps
// the refusal floor intact: nothing relevant ⇒ inject nothing ⇒ the
// persona's "say you don't know" line governs.
export const CHAT_GROUNDING_MIN_SCORE = 0.5;

// Cap the injected passages so a broad query can't balloon the prompt on a
// small context window; the top few by cosine carry the answer.
export const CHAT_GROUNDING_MAX_HITS = 4;

// Skip retrieval for greetings / fragments too short to embed meaningfully
// ("hi", "ok", "thanks") — they never carry a factual question and the
// embed round-trip would be pure latency.
const MIN_QUERY_CHARS = 4;

/**
 * Format relevant recall hits into an authoritative grounding block, or "" when
 * nothing clears the threshold. The wording is deliberately fact-framed and
 * anti-abstention: in live testing qwen3:8b would otherwise hedge to a generic
 * answer even with the note in context, so the block states plainly that these
 * passages are the source of truth and must be cited, not overridden.
 */
export function formatChatGroundingBlock(
  hits: readonly RecallHit[],
  minScore: number = CHAT_GROUNDING_MIN_SCORE
): string {
  const relevant = hits
    .filter((hit) => hit.score >= minScore)
    .slice(0, CHAT_GROUNDING_MAX_HITS);
  if (relevant.length === 0) return "";
  const lines = relevant.map((hit) => `- ${hit.snippet.trim()} [from ${hit.ref}]`);
  return (
    "\n\nThe following passages are from the user's OWN notes — they are the " +
    "authoritative source for any question about the user's data, plans, or " +
    "facts. When the answer is in them, state it directly and cite " +
    "[from <source>]; do NOT override them with general knowledge or hedge to " +
    "a generic answer.\n" +
    lines.join("\n")
  );
}

/**
 * Retrieve + format the grounding block for one chat turn. Fail-soft to "" on
 * a too-short turn, a missing index, or Ollama being down — so the chat surface
 * degrades to the un-grounded refusal floor, never an error.
 */
export interface ChatGrounding {
  /** Authoritative grounding block for the system prompt (may be ""). */
  readonly block: string;
  /** The retrieved evidence — for the deterministic answer gate below. */
  readonly matches: readonly KnowledgeMatch[];
}

function hitsToMatches(hits: readonly RecallHit[]): KnowledgeMatch[] {
  // searchRecall's `score` IS the absolute cosine, which verifyGrounding's
  // retrieval-confidence grading expects in `cosine`.
  return hits.map((hit) => ({ cosine: hit.score, score: hit.score, source: hit.ref, text: hit.snippet }));
}

/**
 * Retrieve the grounding block AND the raw evidence for one chat turn. The
 * evidence feeds the deterministic `gateChatAnswer` so an un-grounded personal
 * fact can be refused by CODE, not left to a prompt instruction qwen3:8b ignores.
 */
export async function retrieveChatGrounding(
  message: string,
  opts: {
    readonly embedModel?: string;
    readonly env?: Record<string, string | undefined>;
    readonly minScore?: number;
  } = {}
): Promise<ChatGrounding> {
  const trimmed = message.trim();
  if (trimmed.length < MIN_QUERY_CHARS) return { block: "", matches: [] };
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  if (env.MUSE_CHAT_GROUNDING === "0") return { block: "", matches: [] };
  const embedModel = opts.embedModel ?? env.MUSE_RECALL_EMBED_MODEL?.trim() ?? "nomic-embed-text";
  try {
    const hits = await searchRecall({
      query: trimmed,
      source: "all",
      limit: CHAT_GROUNDING_MAX_HITS,
      embedModel,
      env
    });
    return { block: formatChatGroundingBlock(hits, opts.minScore ?? CHAT_GROUNDING_MIN_SCORE), matches: hitsToMatches(hits) };
  } catch {
    return { block: "", matches: [] };
  }
}

export async function groundChatTurn(
  message: string,
  opts: {
    readonly embedModel?: string;
    readonly env?: Record<string, string | undefined>;
    readonly minScore?: number;
  } = {}
): Promise<string> {
  return (await retrieveChatGrounding(message, opts)).block;
}

const HANGUL = /[가-힣]/u;

/**
 * Is this a question asking to RECALL a specific fact about the USER'S OWN data
 * (where inventing an answer is a fabrication, not general knowledge)? Narrow on
 * purpose: a first-person possessive + a fact interrogative, excluding advice
 * ("내 아침 루틴 추천") so general/advice turns are never gated.
 */
export function isPersonalFactRecall(question: string): boolean {
  const q = question.trim();
  // Must be the user asking about THEIR OWN data...
  const possessive = /(^|\s)(내|제|나의|내가|my\b|what'?s my|what is my)/iu.test(q);
  // ...for a stored fact...
  const asksFact = /(이름|비밀번호|비번|번호|주소|생일|이메일|메일|나이|뭐|무엇|뭔|언제|어디|얼마|몇|what|when|where|which|who)/iu.test(q);
  // ...as a QUESTION (not a STATEMENT that PROVIDES the fact — "내 비번은 1234야"
  // is the user telling us, which must never be refused)...
  const isQuestion = /[?？]/u.test(q) || /(뭐|무엇|뭔|뭐야|뭐였|뭐지|언제|어디|얼마|몇|what|when|where|which|who)/iu.test(q);
  // ...and not advice (general help, not recall).
  const advice = /(추천|방법|어떻게|왜|recommend|how (do|to|can|should)|why|explain|설명|tip)/iu.test(q);
  return possessive && asksFact && isQuestion && !advice;
}

export function chatAbstention(question: string): string {
  return HANGUL.test(question)
    ? "그건 아직 기억하고 있지 않아요. 알려주시면 기억해둘게요."
    : "I don't have that recorded yet — tell me and I'll remember it.";
}

/**
 * The deterministic anti-fabrication gate for the conversational surface. For a
 * personal-fact recall whose answer is NOT grounded in the retrieved evidence
 * (notes/episodes + the conversation so far), refuse honestly instead of letting
 * qwen3:8b invent a fact framed as memory. Pure + synchronous (no extra model
 * call): `verifyGrounding` is a rubric over the answer + evidence. Non-recall /
 * general turns pass through untouched, so general knowledge is never refused.
 */
// Personal-fact topics → fact-key fragments. ENTITY-AWARE so "고양이 이름" (cat)
// can't be satisfied by a stored dog_name. When a question's specific topic has a
// matching stored key, the answer is real-data-backed even if its surface form
// differs across languages (romanized "jinan" voiced as "진안"), so don't refuse.
// A topic with NO matching key (a never-recorded cat) falls through to the gate.
// The name topic is the USER's OWN name only (possessive directly before
// 이름/name) so an entity's name never satisfies `user_name`. NB: no `\b` next to
// Hangul — JS `\b` is ASCII-only and `이름\b` fails on "이름이".
const FACT_TOPICS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/(내|제|나의|내가|my|what'?s my|what is my)\s*(이름|name)/iu, ["user_name"]],
  [/강아지|반려견|puppy|dog/iu, ["dog"]],
  [/고양이|냥이|cat|kitty/iu, ["cat"]],
  [/자동차|car|vehicle/iu, ["car", "vehicle"]],
  [/비밀번호|비번|암호|password|passcode/iu, ["password", "passcode", "pw"]],
  [/생일|birth/iu, ["birth"]],
  [/나이|age/iu, ["age"]],
  [/이메일|메일|email|e-mail/iu, ["email", "mail"]],
  [/전화|연락처|phone/iu, ["phone", "tel"]],
  [/주소|address/iu, ["address", "addr"]]
];

function asksAboutStoredFact(question: string, knownFactKeys: readonly string[]): boolean {
  const keys = knownFactKeys.map((key) => key.toLowerCase());
  return FACT_TOPICS.some(([topic, fragments]) => topic.test(question) && fragments.some((frag) => keys.some((key) => key.includes(frag))));
}

export function gateChatAnswer(
  question: string,
  answer: string,
  matches: readonly KnowledgeMatch[],
  knownFactKeys: readonly string[] = []
): string {
  if (!isPersonalFactRecall(question)) return answer;
  // Muse genuinely HAS a fact for this SPECIFIC topic → real-data-backed
  // (cross-language tolerant); pass. Otherwise the lexical gate decides, so a
  // cross-entity conflation ("the cat is 보리", the dog's name) is refused.
  if (asksAboutStoredFact(question, knownFactKeys)) return answer;
  const { verdict } = verifyGrounding(answer, matches, question);
  return verdict === "grounded" ? answer : chatAbstention(question);
}

/**
 * Prior conversation turns as authoritative evidence — a fact the user stated
 * earlier THIS session is grounded, so the gate must not refuse to recall it.
 */
export function conversationMatches(
  history: readonly { readonly role: string; readonly content: string }[]
): KnowledgeMatch[] {
  return history
    .filter((turn) => turn.content.trim().length > 0)
    .map((turn) => ({ cosine: 1, score: 1, source: "conversation", text: turn.content }));
}
