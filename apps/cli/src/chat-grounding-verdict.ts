import { assertiveUnsupportedFraction, reportSentenceGroundedness, stripCitationMarkers, verifyGrounding, verifyGroundingWithReverify, type GroundingReverify, type KnowledgeMatch } from "@muse/agent-core";
import { misgroundedOutcome, type AskOutcome } from "@muse/recall";

import {
  answerAssertsUnsupportedDate,
  answerAssertsUnsupportedEmail,
  answerAssertsUnsupportedIdentifier,
  answerAssertsUnsupportedIpAddress,
  answerAssertsUnsupportedNumber,
  answerAssertsUnsupportedUrl
} from "./chat-grounding-value-gate.js";
import { resolveGroundingMinScore } from "./chat-grounding-evidence.js";

/**
 * The chat-surface misgrounding fraction — the per-ASSERTIVE-sentence unsupported
 * share of a chat answer against its retrieved evidence. The deterministic lexical
 * core of the ASK probe (commands-ask.ts: strip Muse's own citation markers, then
 * `assertiveUnsupportedFraction(reportSentenceGroundedness(...))`), so chat and ask
 * agree on what "unsupported" means — NOT a divergent metric. The chat gate is
 * sync-by-design (no model call), so this omits ask's cross-lingual semantic re-judge;
 * the `< 1` upper bound in {@link misgroundedOutcome} keeps the cross-lingual lexical-0
 * artifact (KO answer over EN notes) out of the misgrounding band regardless. Pure.
 */
export function chatMisgroundingFraction(answer: string, matches: readonly KnowledgeMatch[]): number {
  const evidence = matches.map((match) => match.text);
  if (evidence.length === 0) return 0;
  const report = reportSentenceGroundedness(stripCitationMarkers(answer), evidence);
  return assertiveUnsupportedFraction(report);
}

export type ChatWeaknessAxis = "grounding-gap" | "misgrounding" | "unbacked-action";

/**
 * The weakness axis (if any) a chat turn signals — the parity of `askWeaknessAxis`
 * for the conversational surface. Precedence mirrors ask EXACTLY:
 * `unbacked-action` (a claimed-but-unperformed action — a false promise) > `misgrounding`
 * (a non-refusal answer that cites real sources which don't actually support it,
 * GROUNDED != TRUE) > `grounding-gap` (a refusal/empty-fallback — couldn't answer).
 *
 * Strictly additive: a fully-supported grounded answer (fraction below the floor)
 * yields null (writes nothing); a cross-lingual artifact (fraction == 1.0) stays
 * grounded via {@link misgroundedOutcome} and also yields null; a refusal is a
 * `grounding-gap`, NOT a misgrounding (a refusal asserts no claim to misground).
 */
export function chatWeaknessAxis(args: {
  readonly refusal: boolean;
  readonly unbackedAction: boolean;
  readonly answer: string;
  readonly matches: readonly KnowledgeMatch[];
}): ChatWeaknessAxis | null {
  if (args.unbackedAction) return "unbacked-action";
  if (args.refusal) return "grounding-gap";
  const unsupportedFraction = chatMisgroundingFraction(args.answer, args.matches);
  if (misgroundedOutcome({ outcome: "grounded", unsupportedFraction }) === "misgrounded") {
    return "misgrounding";
  }
  return null;
}

/**
 * Map a chat turn to the run-log `grounded` OUTCOME label (the ask-path vocabulary
 * the error-analysis flywheel reads), so a chat misgrounding becomes trace FUEL
 * instead of vanishing as a `grounded:null` happy-path row. Parity with ask's
 * askOutcomeLabel→misgroundedOutcome chain via the shared {@link chatWeaknessAxis}:
 * misgrounding→`misgrounded` (the failure class run-log-analysis clusters), a
 * refusal→`abstain` (honest, NOT a failure), a supported answer→`grounded`. An
 * `unbacked-action` is an action failure, not a grounding verdict → no label
 * (the turn's `success:false` / heads-up carries it). Pure.
 */
export function chatTraceOutcome(args: {
  readonly refusal: boolean;
  readonly unbackedAction: boolean;
  readonly answer: string;
  readonly matches: readonly KnowledgeMatch[];
}): AskOutcome {
  switch (chatWeaknessAxis(args)) {
    case "misgrounding": return "misgrounded";
    case "grounding-gap": return "abstain";
    case "unbacked-action": return null;
    default: return "grounded";
  }
}

/**
 * A chat turn was a GROUNDED SUCCESS — a genuine, evidence-backed answer that
 * signals no weakness (axis null) AND actually cited real grounding (≥1 match).
 * The parity of ask's `askOutcome === "grounded"` resolve trigger: such a turn
 * RESOLVES the topic's grounding-gap (BKT mastery) so a now-answered recurring
 * gap stops nudging. A refusal / misgrounding / unbacked-action (axis non-null)
 * or a no-evidence answer (matches empty) is NOT a grounded success. Pure.
 */
export function isChatGroundedSuccess(args: {
  readonly refusal: boolean;
  readonly unbackedAction: boolean;
  readonly answer: string;
  readonly matches: readonly KnowledgeMatch[];
}): boolean {
  return args.matches.length > 0 && chatWeaknessAxis(args) === null;
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
export function noteGroundedAnswer(noteText: string, answerLower: string): boolean {
  const tokens = noteText.toLowerCase().match(/[a-z0-9가-힣]+/giu) ?? [];
  return tokens.some((token) => (token.length >= 5 || /\d/u.test(token)) && answerLower.includes(token));
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
  // A drifted ISO date (same year, wrong day/month) the number guard splits and
  // misses — a wrong calendar/renewal/deadline date is high-harm.
  if (answerAssertsUnsupportedDate(answer, matches, question)) return "abstain";
  if (answerAssertsUnsupportedNumber(answer, matches, question)) return "abstain";
  // Same deterministic guard for a verbatim EMAIL identifier — a wrong domain on
  // a right local-part is an outbound-safety hazard the token shortcut misses.
  if (answerAssertsUnsupportedEmail(answer, matches, question)) return "abstain";
  // Same deterministic guard for a mixed letter+digit identifier — a wrong SSID
  // / code the lexical-coverage rubric waves through (non-numeric string drift).
  if (answerAssertsUnsupportedIdentifier(answer, matches, question)) return "abstain";
  // Same deterministic guard for a URL / bare domain — a fabricated login/portal
  // host (no >= 3-digit run, splits to pure-alpha parts) both the number and
  // identifier guards miss; a wrong link is a phishing-adjacent hazard.
  if (answerAssertsUnsupportedUrl(answer, matches, question)) return "abstain";
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
  // Use the SAME embedder-aware floor as retrieval so the answer gate doesn't
  // re-abstain on a genuine v2-moe hit (≈0.46) that the 0.5/0.55 nomic bar would
  // wrongly call "weak" — which would undo the retrieval fix.
  const { verdict } = verifyGrounding(answer, matches, question, { confidentAt: resolveGroundingMinScore() });
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
  // Same embedder-aware floor as the retrieval filter + the non-reverify gate, so
  // the reverify-escalation path doesn't judge a genuine v2-moe hit against the
  // stale nomic bar.
  const { verdict } = await verifyGroundingWithReverify(answer, matches, question, reverify, { confidentAt: resolveGroundingMinScore() });
  return verdict === "grounded" ? answer : chatAbstention(question);
}
