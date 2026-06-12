import { readFile } from "node:fs/promises";

import { independentWitnessCount, quorumVerdict, verifyGrounding, verifyGroundingWithReverify, type GroundingReverify, type KnowledgeMatch } from "@muse/agent-core";

import { defaultNotesIndexFile, searchRecall, type RecallHit } from "./commands-recall.js";
import { DEFAULT_EMBED_MODEL, resolveIndexModel } from "./embed-model-default.js";

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

/**
 * The cosine a retrieval hit must clear to be treated as authoritative. Defaults
 * to CHAT_GROUNDING_MIN_SCORE (0.5); `MUSE_GROUNDING_MIN_COSINE` overrides it with
 * the conformal-calibrated value from `muse doctor --calibration` (e.g. 0.559 at
 * α=0.10). Opt-in: the floor is unchanged until a value is set, and an
 * out-of-range value is ignored, so a bad env can never silently break the gate.
 */
export function resolveGroundingMinScore(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MUSE_GROUNDING_MIN_COSINE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : CHAT_GROUNDING_MIN_SCORE;
}

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
/**
 * A short, user-facing citation source. A note's `ref` is its ABSOLUTE path
 * ("/Users/me/.muse/notes/wifi_passwords/seoul_office.md") — ugly, it leaks the
 * home dir, AND it is so long the local model spent its output budget echoing
 * it and TRUNCATED the answer mid-citation. Strip to the path under the notes
 * dir ("wifi_passwords/seoul_office.md"), else the basename. Non-path refs
 * (conversation, …) pass through untouched.
 */
export function shortCitationRef(ref: string): string {
  const marker = "/notes/";
  const idx = ref.lastIndexOf(marker);
  if (idx >= 0) return ref.slice(idx + marker.length);
  if (ref.includes("/")) return ref.slice(ref.lastIndexOf("/") + 1);
  return ref;
}

export function formatChatGroundingBlock(
  hits: readonly RecallHit[],
  minScore: number = resolveGroundingMinScore()
): string {
  const relevant = hits
    .filter((hit) => hit.score >= minScore)
    .slice(0, CHAT_GROUNDING_MAX_HITS);
  if (relevant.length === 0) return "";
  const lines = relevant.map((hit) => `- ${hit.snippet.trim()} [from ${shortCitationRef(hit.ref)}]`);
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
/**
 * Auto-refresh the notes index on a chat turn unless explicitly opted out
 * (`MUSE_CHAT_AUTO_REINDEX=0`). The desktop companion only ever runs `chat`, so
 * this is what lets it answer from a note the user just added.
 */
export function chatAutoReindexEnabled(env: Record<string, string | undefined>): boolean {
  return env.MUSE_CHAT_AUTO_REINDEX !== "0";
}

/**
 * Preserve the embedding model a stale index was built with, so a chat-path
 * refresh never silently re-embeds a custom-model index with the default —
 * except the LEGACY default, which migrates once to the shipped multilingual
 * default (resolveIndexModel) so the upgrade reaches existing users.
 */
export function pickReindexModel(existingModel: string | undefined, requested: string): string {
  return resolveIndexModel(existingModel, requested);
}

/**
 * If the notes index is stale, incrementally rebuild it — targeting the SAME
 * file `searchRecall` reads (`defaultNotesIndexFile`), so a chat refresh can
 * never write where the search won't look. Lazy-imports the heavy notes-rag
 * module so it stays out of the bundled desktop binary's startup graph.
 */
async function refreshStaleNotesIndexForChat(env: Record<string, string | undefined>, embedModel: string): Promise<void> {
  const indexPath = defaultNotesIndexFile();
  const { resolveNotesDir } = await import("@muse/autoconfigure");
  const { isNotesIndexStale, reindexNotes } = await import("./commands-notes-rag.js");
  const notesDir = resolveNotesDir(env);
  if (!(await isNotesIndexStale(notesDir, indexPath))) return;
  let existingModel: string | undefined;
  try {
    existingModel = (JSON.parse(await readFile(indexPath, "utf8")) as { model?: string }).model;
  } catch {
    existingModel = undefined;
  }
  await reindexNotes({ dir: notesDir, indexPath, model: pickReindexModel(existingModel, embedModel) });
}

/**
 * Multi-turn retrieval gap (Rewrite-Retrieve-Read, arXiv:2305.14283): an
 * anaphoric turn ("그거 언제 바뀌었지?") embeds onto the PRONOUN, not the topic,
 * so recall misses the note the conversation is plainly about. Fire only on a
 * short turn that carries an anaphor AND has history to resolve it from — a
 * self-contained question must never pay the extra inference.
 */
export function needsContextualRewrite(message: string, historyLength: number): boolean {
  if (historyLength === 0) return false;
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  return /(그게|그거|그건|그때|거기|아까|방금|걔|이건|저건|그 사람|\bit\b|\bthat\b|\bthen\b|\bthere\b|\bhe\b|\bshe\b|\bthey\b)/iu.test(trimmed);
}

export const QUERY_REWRITE_RESPONSE_FORMAT = {
  properties: { query: { type: "string" } },
  required: ["query"],
  type: "object"
};

export const QUERY_REWRITE_SYSTEM_PROMPT =
  "Rewrite the user's LAST message as ONE self-contained search query by resolving its pronouns/references from the conversation. Keep the user's language. Use ONLY words and facts present in the conversation — never invent new ones. Reply as JSON: {\"query\": \"...\"}.";

export function buildQueryRewritePrompt(
  history: readonly { readonly role: string; readonly content: string }[],
  message: string
): string {
  const recent = history.slice(-4).map((turn) => `${turn.role}: ${turn.content}`);
  return [...recent, `user (LAST message to rewrite): ${message}`].join("\n");
}

/** Fail-open parse: anything but a sane constrained JSON keeps the original query. */
export function parseQueryRewrite(output: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    if (parsed && typeof parsed === "object" && "query" in parsed) {
      const query = (parsed as { query: unknown }).query;
      if (typeof query === "string" && query.trim().length > 0 && query.length <= 200) {
        return query.trim();
      }
    }
  } catch {
    // fall through to the original message
  }
  return fallback;
}

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
  const embedModel = opts.embedModel ?? env.MUSE_RECALL_EMBED_MODEL?.trim() ?? DEFAULT_EMBED_MODEL;
  // Refresh a stale notes index before searching — the courtesy `muse ask`
  // already extends. The desktop companion only ever calls `chat`, so without
  // this a note the user just added is unreachable until they remember to run
  // `muse notes reindex`. Fail-soft: search whatever index exists.
  if (chatAutoReindexEnabled(env)) {
    await refreshStaleNotesIndexForChat(env, embedModel).catch(() => undefined);
  }
  try {
    const hits = await searchRecall({
      query: trimmed,
      source: "all",
      limit: CHAT_GROUNDING_MAX_HITS,
      embedModel,
      env
    });
    return { block: formatChatGroundingBlock(hits, opts.minScore ?? resolveGroundingMinScore()), matches: hitsToMatches(hits) };
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


export interface FinalizeGatedChatAnswerArgs {
  readonly question: string;
  readonly answer: string;
  readonly matches: readonly KnowledgeMatch[];
  readonly history?: readonly { readonly role: string; readonly content: string }[];
  readonly toolsUsed?: readonly string[];
  /**
   * The `{ source, text }` evidence the read-tools actually produced this turn
   * (the agent run's `groundingSources`). When NON-EMPTY the semantic coverage
   * gate is skipped (a tool/web answer legitimately scores low note-coverage),
   * but the deterministic value checks STILL run against this evidence — so a
   * number/email the tool did not return is caught. A tool that RAN but produced
   * nothing leaves this empty, so the full gate runs (no blanket bypass).
   */
  readonly toolGroundingSources?: readonly { readonly source: string; readonly text: string }[];
  readonly knownFactKeys?: readonly string[];
  readonly reverify?: GroundingReverify;
}

/**
 * The ONE post-stream pipeline every conversational surface must run — the
 * audit found the Ink chat rendered the raw stream (no gate, no citation
 * strip, no receipt) while runLocalChat had all four steps inline, and the
 * divergence let a fabrication persist into the history as cosine-1
 * "conversation evidence". Shared here so the surfaces cannot drift again:
 * gate (reverify-backed when a judge is supplied) → truncated-citation strip →
 * fabricated-citation strip → source receipt.
 */
export async function finalizeGatedChatAnswer(args: FinalizeGatedChatAnswerArgs): Promise<string> {
  // A tool's own output is evidence too — fold it in so the value checks treat a
  // value the tool actually returned as supported (cosine 1, like conversation).
  const toolEvidence: KnowledgeMatch[] = (args.toolGroundingSources ?? []).map(
    (source) => ({ cosine: 1, score: 1, source: source.source, text: source.text })
  );
  // Grounded by a tool ONLY when it produced real evidence — not merely because a
  // tool was called (a tool that ran but returned nothing must not bypass).
  const toolGrounded = toolEvidence.length > 0;
  const evidence = [...args.matches, ...conversationMatches(args.history ?? []), ...toolEvidence];
  const gated = toolGrounded
    ? gateChatAnswerDeterministic(args.question, args.answer, evidence, args.knownFactKeys ?? [])
    : args.reverify
      ? await gateChatAnswerWithReverify(args.question, args.answer, evidence, args.knownFactKeys ?? [], args.reverify)
      : gateChatAnswer(args.question, args.answer, evidence, args.knownFactKeys ?? []);
  const repaired = stripTruncatedCitation(gated);
  const deFabbed = stripFabricatedCitations(repaired, args.matches.map((match) => match.source));
  return withGroundingReceipt(deFabbed, groundedNoteSources(args.matches, deFabbed), /[가-힣]/u.test(args.question));
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
  // `내`/`제` (my) must be a STANDALONE word (followed by a space), or the
  // first-person `내가`/`제가`. Without the boundary, bare `내`/`제` matched
  // "내일" (tomorrow) and "제일" (most) — so "이번 주 뭐가 제일 급해?" was wrongly
  // treated as fact-recall and abstained despite the tasks that answer it.
  const possessive = /(^|\s)(내(?=\s)|제(?=\s)|내가|제가|나의|my\b|what'?s my|what is my)/iu.test(q);
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

export function isChatAbstention(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === chatAbstention("가").trim() || trimmed === chatAbstention("a").trim();
}

// A model-PHRASED disclaimer of having the asked-for info — not the canonical
// `chatAbstention` string, so `isChatAbstention` misses it. Used to suppress the
// 📎 receipt: a source receipt on a "정보는 기록에 없습니다" / "I don't have
// that" answer is actively misleading — it implies the note answered when the
// answer itself says it didn't (observed live: the model parroted a tangential
// note phrase into an abstention, which a single ≥5-char token then mis-cited).
// Tuned to strong disclaim idioms; a genuine grounded answer that merely tacks
// on "그 외 정보는 없어요" may lose its receipt — an accepted trade, since citing
// a source on a non-answer breaks the honesty edge harder than a missing receipt.
const NO_INFO_RE = /기록에\s*없|정보[가는를도]?\s*(?:현재\s*)?(?:제\s*)?(?:기록에\s*)?없|알\s*수\s*없|찾을\s*수\s*없|확인할\s*수\s*없|가지고\s*있지\s*않|\bdo(?:es)?\s*n'?t\s+have\b|\bdo\s+not\s+have\b|\bno\s+(?:information|record|data)\b|\bnot\s+in\s+(?:my|the|your)\s+records?\b|\b(?:can'?t|cannot|could\s*n'?t)\s+find\b|\bnot\s+sure\b/iu;

/** Does the answer DISCLAIM having the asked-for information? Broader than the
 * canonical `isChatAbstention` — catches a free-form model abstention so a 📎
 * source receipt is never stapled onto a "no information" reply. */
export function expressesNoInformation(text: string): boolean {
  return NO_INFO_RE.test(text);
}

// A note actually GROUNDED the answer only if a distinctive token from it (a
// value with a digit, or a word ≥5 chars — not a common word shared by the
// question) shows up in the answer. This keeps the receipt accurate: an answer
// of "muse2026" cites seoul_office.md, not every loosely-retrieved note.
function noteGroundedAnswer(noteText: string, answerLower: string): boolean {
  const tokens = noteText.toLowerCase().match(/[a-z0-9가-힣]+/giu) ?? [];
  return tokens.some((token) => (token.length >= 5 || /\d/u.test(token)) && answerLower.includes(token));
}

/** The note/source refs (basenames) that actually grounded the answer — above the
 * authoritative threshold AND with content present in the answer, deduped. Drives
 * the accurate "source quoted" receipt on chat. */
export function groundedNoteSources(
  matches: readonly KnowledgeMatch[],
  answer: string,
  minScore: number = resolveGroundingMinScore()
): string[] {
  const answerLower = answer.toLowerCase();
  const refs = matches
    .filter((match) => (match.cosine ?? match.score) >= minScore && noteGroundedAnswer(match.text, answerLower))
    .map((match) => {
      const parts = match.source.trim().split(/[/\\]/u);
      return parts[parts.length - 1] ?? match.source.trim();
    })
    .filter((ref) => ref.length > 0);
  return [...new Set(refs)];
}

/**
 * Drop a DANGLING inline citation. In the grounded-recall runtime context the
 * local model sometimes stops mid-citation (`done_reason=stop`, e.g. "…[from
 * wifi_passwords/seoul_office." with no closing "]"), leaving a broken,
 * path-leaky fragment AND blocking the 📎 receipt (which skips when the answer
 * "[from"-contains a citation). Stripping the unclosed fragment lets the clean
 * receipt stand in. A COMPLETE inline citation (has a "]") is left untouched.
 */
export function stripTruncatedCitation(answer: string): string {
  const idx = answer.lastIndexOf("[from");
  if (idx < 0 || answer.indexOf("]", idx) >= 0) return answer;
  return answer.slice(0, idx).trimEnd();
}

/**
 * Strip an inline `[from X]` citation whose X is NOT a source actually placed in
 * the grounding context. The local model invents citations for data it never
 * grounded — "현재 비가 옵니다 [from weather]" with no weather tool call, "[from
 * internet]", "[from memory]" — which fakes the "shows its work" edge: a source
 * marker the user can't trust. Only a citation naming a real retrieved source
 * (by its notes-relative path OR basename) survives; the answer text is kept.
 */
export function stripFabricatedCitations(answer: string, sources: readonly string[]): string {
  if (!answer.includes("[from ")) return answer;
  const valid = new Set<string>();
  for (const source of sources) {
    const short = shortCitationRef(source).toLowerCase();
    valid.add(short);
    valid.add(short.split("/").pop() ?? short);
  }
  return answer
    .replace(/\s*\[from ([^\]]+)\]/gu, (full: string, cited: string) => {
      const c = cited.trim().toLowerCase();
      return valid.has(c) || valid.has(c.split("/").pop() ?? c) ? full : "";
    })
    .replace(/[ \t]+\n/gu, "\n")
    .trimEnd();
}

/** Append a "shows its work" source receipt when chat answered FROM the user's
 * notes — the model often forgets to render [from <source>] inline, but the
 * "answers from your notes, source quoted" promise should still be visible. */
export function withGroundingReceipt(
  answer: string,
  sources: readonly string[],
  korean: boolean,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (sources.length === 0 || isChatAbstention(answer) || expressesNoInformation(answer) || answer.includes("[from")) return answer;
  const label = korean ? "노트" : "from";
  let receipt = `${answer}\n\n📎 ${label}: ${sources.join(", ")}`;
  // Quorum hedge (A2, biology — Becker et al. 2022/2023): when the answer rests
  // on a SINGLE independent witness source, honestly acknowledge it isn't
  // corroborated. Opt-in (`MUSE_QUORUM_HEDGE=1`) and default-off, because most
  // personal facts legitimately live in one note — hedging every one would be
  // noise; this never refuses, it only labels confidence.
  if (env.MUSE_QUORUM_HEDGE === "1" && quorumVerdict(independentWitnessCount(sources)) === "single") {
    receipt += korean
      ? "\n(노트 한 곳에만 근거한 답이에요 — 최신인지 확인해 주세요.)"
      : "\n(Based on a single note — double-check it's current.)";
  }
  return receipt;
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

/**
 * Which stored-fact keys belong in the persona for THIS message. qwen3:8b
 * free-associates a remembered ENTITY fact (the user's dog) into unrelated
 * turns, so don't hand it facts the message isn't about. Keep a fact when:
 *   - it's the user's name (always — needed to address them), OR
 *   - NO topic covers it (an unknown fact type like "dentist" — keep so recall
 *     for it still works), OR
 *   - a topic that covers it MATCHES the message (the user is actually asking
 *     about it, e.g. "내 강아지?" → dog_name).
 * A fact a topic covers but the message doesn't ask about is dropped — that's
 * the dog the model would otherwise drag into "물 왜 중요해?" or "내 이름?".
 */
export function factKeysToInject(message: string, allKeys: readonly string[]): string[] {
  return allKeys.filter((key) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "user_name") return true;
    const coveringTopics = FACT_TOPICS.filter(([, fragments]) => fragments.some((frag) => lowerKey.includes(frag)));
    if (coveringTopics.length === 0) return true;
    return coveringTopics.some(([topic]) => topic.test(message));
  });
}

// Canonical digit string for a written number: strip thousands separators so
// "1,250,000" and "1250000" compare equal. Only runs of >= 3 digits are treated
// as VALUES — 1-2 digit numbers are counts / ordinals ("the 1st", "12th",
// "serves 4") and date parts ("…-02-28"), whose reformatting ("3" vs "03",
// "Sep 14") would otherwise cause false refusals.
function valueNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of text.match(/\d[\d,]*\d|\d/gu) ?? []) {
    const digits = run.replace(/,/gu, "");
    if (digits.length >= 3) out.add(digits);
  }
  return out;
}

/**
 * Does the answer assert a substantive NUMBER present in neither the retrieved
 * evidence nor the question? `muse ask` catches this wrong-VALUE drift with a
 * judge pass (`answerAssertsUnsupportedValue` → reverify, fail-open), but the
 * chat gate is sync-by-design with no model call, so it needs a DETERMINISTIC
 * equivalent. Numbers don't paraphrase, so the false-positive rate is ~0
 * (protecting false-refusal=0); restricting to >= 3-digit values targets the
 * highest-harm class the holistic `coverage` / `noteGroundedAnswer` shortcuts
 * wave through — a wrong MTU (1500 vs the note's 1380), a wrong rent, a
 * fabricated price/phone. Claim-level support applied as code (FActScore atomic
 * facts, Self-RAG ISSUP — arXiv:2305.14251, arXiv:2310.11511). Citations are
 * stripped first so a `[from …2026…]` source is never read as an asserted value.
 */
export function answerAssertsUnsupportedNumber(
  answer: string,
  matches: readonly KnowledgeMatch[],
  question: string
): boolean {
  const answerNumbers = valueNumbers(answer.replace(/\[[^\]]*\]/gu, " "));
  if (answerNumbers.size === 0) return false;
  const supported = new Set<string>(valueNumbers(question));
  for (const match of matches) {
    for (const number of valueNumbers(match.text)) supported.add(number);
  }
  for (const number of answerNumbers) {
    if (!supported.has(number)) return true;
  }
  return false;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/giu;

/**
 * Does the answer assert an EMAIL ADDRESS present in neither the evidence nor
 * the question? Same rationale as {@link answerAssertsUnsupportedNumber}: an
 * email is a verbatim-copied identifier (never paraphrased), so requiring it to
 * appear in the evidence text is false-positive-safe yet catches the highest-harm
 * contact drift — a right local-part with a WRONG domain ("jinan@acme.com" for
 * the note's "jinan@foundry.io"), which the `noteGroundedAnswer` token shortcut
 * waves through because the local-part overlaps the note. A wrong contact address
 * is an outbound-safety hazard, so the chat gate must refuse it as ask does
 * (agent-core's value escalation). Addresses are compared whole, case-insensitively.
 */
export function answerAssertsUnsupportedEmail(
  answer: string,
  matches: readonly KnowledgeMatch[],
  question: string
): boolean {
  const emails = answer.replace(/\[[^\]]*\]/gu, " ").match(EMAIL_RE) ?? [];
  if (emails.length === 0) return false;
  const haystack = `${question} ${matches.map((match) => match.text).join(" ")}`.toLowerCase();
  return emails.some((address) => !haystack.includes(address.toLowerCase()));
}

// An IDENTIFIER token mixes letters AND digits (optionally hyphen-joined): an
// SSID, model number, interface tag, room code — "Nest-5G", "wg0", "B205". Like
// a number or email it is a VERBATIM identifier that never paraphrases, so the
// false-positive rate of requiring it in the evidence is ~0. A pure-digit run
// ("192", "2029-11-03") or pure-letter word ("KRW", "Park") is NOT an
// identifier — those are handled by answerAssertsUnsupportedNumber or are
// paraphrasable prose.
// Canonicalize to the alphanumeric core (drop case + every separator) so a
// copied identifier re-rendered with a different separator — "Nest-5G" vs
// "Nest 5G" vs "nest5g" — compares equal. Without this the guard would FALSE-
// REFUSE a correct answer that merely spaced the value differently.
function canonicalIdentifier(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/giu, "");
}

// The mixed letter+digit identifier tokens an answer asserts, in canonical form.
function answerIdentifiers(text: string): string[] {
  const out: string[] = [];
  for (const token of text.match(/[a-z0-9]+(?:-[a-z0-9]+)*/giu) ?? []) {
    if (/[a-z]/iu.test(token) && /\d/u.test(token)) out.push(canonicalIdentifier(token));
  }
  return out;
}

/**
 * Does the answer assert a mixed letter+digit IDENTIFIER present in neither the
 * evidence nor the question? The string-drift counterpart to
 * {@link answerAssertsUnsupportedNumber}: a wrong SSID ("Linksys-2G" for the
 * note's "Nest-5G") has only a 1-digit run, so the number guard waves it
 * through, and its heavy lexical overlap with the note ("home wifi SSID is …")
 * makes verifyGrounding's coverage rubric score it `grounded` — a fabrication
 * surfaced on the chat surface. Identifiers don't paraphrase, so requiring a
 * verbatim match is false-refusal-safe. (A wrong PURE-ALPHABETIC proper noun —
 * "Mr. Lee" for "Mr. Park" — is NOT covered here: names paraphrase across
 * scripts/titles, so a lexical rule would false-refuse; that residual needs NER
 * or a judge, neither of which fits this sync, no-model-call gate.)
 */
export function answerAssertsUnsupportedIdentifier(
  answer: string,
  matches: readonly KnowledgeMatch[],
  question: string
): boolean {
  const answerIds = answerIdentifiers(answer.replace(/\[[^\]]*\]/gu, " "));
  if (answerIds.length === 0) return false;
  // Substring (not token-equality) against the canonical evidence+question so a
  // separator-variant rendering of a SUPPORTED identifier still matches; only an
  // identifier absent from the evidence in any form is flagged.
  const haystack = canonicalIdentifier(`${question} ${matches.map((match) => match.text).join(" ")}`);
  return answerIds.some((id) => !haystack.includes(id));
}

// Each octet is constrained to 0-255, so the pattern matches a real IPv4 and
// NOT an IP-shaped non-address: a version string ("1.2.3" — only 3 groups), a
// decimal ("3.14"), or a date ("2029-11-03" — hyphens, not dots).
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/gu;

// Collapse the only legitimate re-render of an octet (leading zeros: "01" → "1")
// so a correct address written either way compares equal.
function canonicalIp(ip: string): string {
  return ip.split(".").map((octet) => String(Number.parseInt(octet, 10))).join(".");
}

/**
 * Does the answer assert a whole IPv4 address present in neither the evidence
 * nor the question? {@link answerAssertsUnsupportedNumber} compares >=3-digit
 * runs, so it judges an IP octet-by-octet: "192.168.0.1" and a drifted
 * "192.168.1.1" both reduce to the supported set {192,168} (the 0/1 octets are
 * 1-digit and dropped), and "10.0.0.5" reduces to {} — so a wrong router/admin
 * IP is waved through and surfaced. An IPv4 literal is a verbatim, copy-only
 * identifier that never paraphrases, so matching the WHOLE address is
 * false-refusal-safe; it must run before the number guard splits it into octets.
 */
export function answerAssertsUnsupportedIpAddress(
  answer: string,
  matches: readonly KnowledgeMatch[],
  question: string
): boolean {
  const answerIps = (answer.replace(/\[[^\]]*\]/gu, " ").match(IPV4_RE) ?? []).map(canonicalIp);
  if (answerIps.length === 0) return false;
  const supported = new Set<string>([
    ...(question.match(IPV4_RE) ?? []).map(canonicalIp),
    ...matches.flatMap((match) => (match.text.match(IPV4_RE) ?? []).map(canonicalIp))
  ]);
  return answerIps.some((ip) => !supported.has(ip));
}

type ChatGateDecision = "pass" | "abstain" | "verify";

function chatGatePrecheck(
  question: string,
  answer: string,
  matches: readonly KnowledgeMatch[],
  knownFactKeys: readonly string[]
): ChatGateDecision {
  if (!isPersonalFactRecall(question)) return "pass";
  // Muse genuinely HAS a fact for this SPECIFIC topic → real-data-backed
  // (cross-language tolerant); pass. Otherwise the lexical gate decides, so a
  // cross-entity conflation ("the cat is 보리", the dog's name) is refused.
  if (asksAboutStoredFact(question, knownFactKeys)) return "pass";
  // A substantive number the notes don't contain is a fabricated value even when
  // the rest of the answer overlaps a note — the `noteGroundedAnswer` shortcut
  // and `verifyGrounding`'s whole-answer coverage below would otherwise wave it
  // through (a single wrong number barely dents token coverage). Refuse
  // deterministically: the sync chat counterpart to ask's value escalation.
  // A whole IPv4 first — judged as one unit before the number guard would split
  // it into individually-"supported" octets and miss a wrong router/admin IP.
  if (answerAssertsUnsupportedIpAddress(answer, matches, question)) return "abstain";
  if (answerAssertsUnsupportedNumber(answer, matches, question)) return "abstain";
  // Same deterministic guard for a verbatim EMAIL identifier — a wrong domain on
  // a right local-part is an outbound-safety hazard the token shortcut misses.
  if (answerAssertsUnsupportedEmail(answer, matches, question)) return "abstain";
  // Same deterministic guard for a mixed letter+digit identifier — a wrong SSID
  // / code the lexical-coverage rubric waves through (non-numeric string drift).
  if (answerAssertsUnsupportedIdentifier(answer, matches, question)) return "abstain";
  // The answer actually QUOTES distinctive content from a retrieved note
  // (e.g. "muse2026" from seoul_office.md) → grounded for real, no matter how
  // verifyGrounding's borderline rubric falls on the model's varied phrasing.
  // A fabrication (no note holds the invented value) won't match, so it's safe.
  const answerLower = answer.toLowerCase();
  if (matches.some((match) => (match.cosine ?? match.score) >= resolveGroundingMinScore() && noteGroundedAnswer(match.text, answerLower))) {
    return "pass";
  }
  return "verify";
}

export function gateChatAnswer(
  question: string,
  answer: string,
  matches: readonly KnowledgeMatch[],
  knownFactKeys: readonly string[] = []
): string {
  const decision = chatGatePrecheck(question, answer, matches, knownFactKeys);
  if (decision === "pass") return answer;
  if (decision === "abstain") return chatAbstention(question);
  const { verdict } = verifyGrounding(answer, matches, question);
  return verdict === "grounded" ? answer : chatAbstention(question);
}

/**
 * The DETERMINISTIC half of the chat gate — the always-on value checks (wrong
 * number / email / IP / identifier) WITHOUT the semantic `verifyGrounding`
 * coverage stage. For a tool/web-grounded answer the coverage rubric (calibrated
 * for notes) would false-refuse a faithful answer, so the semantic stage is
 * skipped; but a value the evidence does NOT contain is still abstained. The
 * tool's own output is in `matches`, so a value it actually returned is supported.
 */
export function gateChatAnswerDeterministic(
  question: string,
  answer: string,
  matches: readonly KnowledgeMatch[],
  knownFactKeys: readonly string[] = []
): string {
  return chatGatePrecheck(question, answer, matches, knownFactKeys) === "abstain"
    ? chatAbstention(question)
    : answer;
}

/**
 * The chat gate with ask-parity escalation: the deterministic prechecks are
 * identical to {@link gateChatAnswer}, but the borderline bands (weak
 * retrieval, coverage-only failure, an unsupported asserted value) spend ONE
 * reverify inference instead of hard-falling on the lexical rubric — so chat
 * refuses drift, and rescues cross-lingual phrasing, as reliably as ask.
 * Fail-close: a judge error keeps the abstention.
 */
export async function gateChatAnswerWithReverify(
  question: string,
  answer: string,
  matches: readonly KnowledgeMatch[],
  knownFactKeys: readonly string[],
  reverify: GroundingReverify
): Promise<string> {
  const decision = chatGatePrecheck(question, answer, matches, knownFactKeys);
  if (decision === "pass") return answer;
  if (decision === "abstain") return chatAbstention(question);
  const { verdict } = await verifyGroundingWithReverify(answer, matches, question, reverify);
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
