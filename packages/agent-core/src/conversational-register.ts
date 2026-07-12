/**
 * Deterministic Korean register (반말/존댓말) detection + casual-turn
 * brevity classification — the inputs to the "personalization/register-
 * brevity" dynamic PromptLayer (docs/strategy/prompt-architecture.md §4,
 * D2 tone-hints). Lives beside `casual-prompt.ts` rather than in
 * `@muse/prompts`: `classifyCasualTurn` reuses `classifyCasualPrompt`
 * directly, and `@muse/prompts` has zero package dependencies while
 * `@muse/agent-core` already depends on it — importing an agent-core
 * classifier from prompts would open a prompts -> agent-core -> prompts
 * cycle. Building the `PromptLayer` value itself is fine here: agent-core
 * already imports that type from `@muse/prompts` throughout
 * context-transforms.ts.
 */

import type { PromptLayer } from "@muse/prompts";

import { classifyCasualPrompt } from "./casual-prompt.js";
import { dominantScriptFamily } from "./script-family.js";

export type PersonaRegister = "존댓말" | "반말";

const HANGUL_RE = /[가-힣]/u;

// 하십시오체/해요체 (polite) sentence endings — checked FIRST so a verb
// ending in "다" that is actually "...습니다/합니다" never falls through to
// the 반말 catch-all below (both end in "다").
const JONDAEMAL_ENDING_RE =
  /(?:니다|니까|세요|셔요|십시오|해요|해용|이에요|예요|어요|아요|여요|을까요|ㄹ까요|나요|가요|죠|구요|네요|든요|는데요|을게요|ㄹ게요|고요|지요)$/u;

// 해체/해라체 (informal) sentence endings — only checked once the polite
// list above has already missed, so this never intercepts a "...습니다" /
// "...세요" tail.
const BANMAL_ENDING_RE =
  /(?:거든|잖아|더라|텐데|는군|구나|랬|했어|했지|했냐|했니|했자|었어|았어|할래|ㄹ래|을래|래|해줘|줘|해|돼|봐|워|와|야|지|니|자|게|까|네|다|음|재|랴|어|아)$/u;

const BANMAL_VOCATIVE_RE = /^(?:너|당신|자네)?\s*(?:야|어이|인마|얌마)\b/u;

function endingCore(text: string): string {
  return text.trim().replace(/[?!.…~\s]+$/u, "");
}

/**
 * Deterministic 반말/존댓말 classification from verb-ending + particle
 * signals — never an LLM call. Ending-anchored: the FINAL predicate decides
 * the register of the whole utterance, so a turn that opens politely but
 * closes in 반말 ("정말요? 그거 해줄래") reads as 반말 — that is the register
 * to mirror. No Hangul at all (English/empty), or no ending/vocative signal
 * whatsoever (a bare noun), is "unknown" — never guessed.
 */
export function detectKoreanRegister(text: string): PersonaRegister | "unknown" {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !HANGUL_RE.test(trimmed)) {
    return "unknown";
  }
  const core = endingCore(trimmed);
  if (JONDAEMAL_ENDING_RE.test(core)) {
    return "존댓말";
  }
  if (BANMAL_ENDING_RE.test(core) || BANMAL_VOCATIVE_RE.test(trimmed)) {
    return "반말";
  }
  return "unknown";
}

// Mood/state small talk ("심심해", "피곤해") — not a greeting/thanks/farewell,
// but exactly the casual-turn kind whose measured baseline answer was a
// 921-char numbered list with an unsolicited follow-up.
const MOOD_STATE_RE =
  /^(?:심심해(?:요)?|심심하다|피곤해(?:요)?|힘들어(?:요)?|배고파(?:요)?|졸려(?:요)?|우울해(?:요)?|bored|tired|sleepy|hungry)[.!~]*$/iu;

// An affective musing / observation ("오늘 날씨 좋다", "이 노래 좋다", "커피
// 맛있다") — a statement, not a question or request. Measured live: these fell
// THROUGH the casual classification to the lead-with-answer nudge, so a pure
// musing got an unsolicited "더 자세히 알려줄까?" expansion offer — chatter
// turned into forced helpfulness (service-bot, not companion). Anchored to an
// affective/descriptive predicate at the END so a request that merely contains
// the adjective ("날씨 좋으면 산책 계획 짜줘") or a question ("이 방법이 좋아?")
// is not swept in.
const MUSING_STATEMENT_RE =
  /(?:좋다|좋네|좋아|좋군|좋구나|좋은데|맛있다|맛있네|맛있어|맛나|예쁘다|예쁘네|이쁘다|이쁘네|멋지다|멋지네|멋있다|멋있네|재밌다|재미있다|재밌네|재밌어|귀엽다|귀여워|덥다|춥다|따뜻하다|따뜻해|시원하다|시원해|행복하다|행복해|기쁘다|기뻐|신난다|신나|설렌다|편하다|편해|배부르다|나른하다|뿌듯하다|뿌듯해)[.!~ㅋㅎ]*$/u;

// A casual "what should we/I do" decision question ("오늘 뭐하지", "뭐 먹을까").
const CASUAL_DECISION_RE = /뭐\s?(?:하지|할까|먹을까|볼까|살까|입지|타지)\s*[?？]?$/u;

// A casual lead-in announcing a small, informal question is coming.
const CASUAL_ASK_LEADIN_RE =
  /^(?:뭐\s?좀\s?물어볼게|뭐\s?하나\s?물어봐도\s?(?:돼|될까)|질문\s?하나\s?해도\s?(?:돼|될까))/u;

// A short, simple "what is X" definition question.
const SIMPLE_DEFINE_KO_RE =
  /^.{1,20}?(?:가|이|는|은)?\s*(?:뭐야|뭐예요|뭔가요|뭐지|뭐임|뭐니|무엇(?:인가요|이야|이에요)?)\s*[?？]?$/u;
const SIMPLE_DEFINE_EN_RE = /^what(?:'s| is)\s+.{1,30}\??$/iu;

// A turn that names its own scale or asks for depth ("500줄", "코드 리뷰",
// "분석해줘", "자세히 설명해줘") genuinely needs a full answer regardless of
// how short the sentence itself is — this must win over every casual
// pattern above so a legitimate long-answer request is never truncated.
const SUBSTANTIAL_REQUEST_RE =
  /코드|리뷰|review|분석해|analyze|정리해줘|(?:설명해줘|explain)\s*(?:자세히|전부|모두|in detail)|\d+\s*(?:줄|lines?|words?|페이지)/iu;

/**
 * True for a SHORT casual/small-talk/simple-question turn where a long,
 * structured answer is a defect (a 916-char explainer for "파이썬이 뭐야?").
 * Reuses `classifyCasualPrompt` for the pure social-phrase arm (greeting /
 * thanks / farewell) instead of a parallel pattern list, and extends it with
 * mood statements, casual decision questions, and short "what is X" asks —
 * kinds `classifyCasualPrompt` doesn't cover because its job is different
 * (deciding whether to skip retrieval on the recall surface, not whether an
 * answer should be brief). An explicit long-answer marker (code/line-count/
 * review/detail request) always wins, however short the sentence.
 */
export function classifyCasualTurn(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 60) {
    return false;
  }
  if (SUBSTANTIAL_REQUEST_RE.test(trimmed)) {
    return false;
  }
  if (classifyCasualPrompt(trimmed) !== null) {
    return true;
  }
  return (
    MOOD_STATE_RE.test(trimmed) ||
    MUSING_STATEMENT_RE.test(trimmed) ||
    CASUAL_DECISION_RE.test(trimmed) ||
    CASUAL_ASK_LEADIN_RE.test(trimmed) ||
    SIMPLE_DEFINE_KO_RE.test(trimmed) ||
    SIMPLE_DEFINE_EN_RE.test(trimmed)
  );
}

export const REGISTER_BREVITY_LAYER_ID = "personalization/register-brevity";
// Dynamic-section D2 tone-hint (docs/strategy/prompt-architecture.md
// canonical stack) — after the cache boundary, ahead of D3/D4/D5.
export const REGISTER_BREVITY_LAYER_PRIORITY = 50;

const REGISTER_INSTRUCTION: Readonly<Record<PersonaRegister, string>> = {
  "반말": "사용자가 반말을 썼다 — 존댓말 대신 반말로 답하라.",
  "존댓말": "사용자가 존댓말을 썼다 — 존댓말을 유지하라."
};

const BREVITY_INSTRUCTION =
  "이건 가벼운 대화다 — 1~2문장(약 120자 이내)으로 짧게 답하라. 번호 목록이나 추가 질문 없이 핵심만 답하라.";

// The user EXPLICITLY asked for a short answer ("한 줄로만", "짧게: …",
// "briefly, …"). Each alternative requires a directive SHAPE — a colon/comma
// introducing the real question, or the marker itself acting as the
// sentence's verb ("답해줘"/"설명해줘") — never a bare mention. This is what
// keeps "짧은 문장 만드는 법" (a question ABOUT short sentences, a topic) from
// misfiring: "짧은" alone is not in this pattern, only "짧은 답변/대답" (asking
// FOR a short answer) is.
const BRIEF_REQUEST_KO_RE =
  /(?:한\s?줄(?:로|만)|1\s?줄(?:로|만)?)\s*(?:만)?\s*[:,]|(?:짧게|간단히|간략히|간단하게|요약해서)\s*[:,]|(?:짧게|간단히|간략히|간단하게|요약해서)\s*(?:답해|답변|대답해|말해|알려|설명해|써줘|부탁)|짧은\s*(?:답변|대답)/u;
const BRIEF_REQUEST_EN_RE = /\b(?:in one line|briefly|short answer|tl;?dr|in short|concisely)\b/iu;

/**
 * True when the user's OWN text explicitly directs a short answer — this
 * must OUTRANK the gentle casual-turn brevity, because the model ignores a
 * generic "keep it short" hint but obeys a strong, singular instruction
 * (measured: brief-requests violated ≤100 chars by 57-96% under the generic
 * casual instruction alone).
 */
export function detectBrevityRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return BRIEF_REQUEST_KO_RE.test(trimmed) || BRIEF_REQUEST_EN_RE.test(trimmed);
}

// The user EXPLICITLY asked for depth/steps/examples. This is the
// anti-over-gating guard: when true, NO brevity or lead-with-answer
// instruction may be added, however short-looking the sentence otherwise
// reads — a truncated "OAuth2 단계별로 자세히" answer is the regression this
// function exists to prevent.
const DETAIL_REQUEST_KO_RE = /자세히|자세하게|단계별|예제|예시|구체적으로|길게/u;
const DETAIL_REQUEST_EN_RE = /\b(?:step[\s-]?by[\s-]?step|in detail|deep dive)\b/iu;

export function detectDetailRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return DETAIL_REQUEST_KO_RE.test(trimmed) || DETAIL_REQUEST_EN_RE.test(trimmed);
}

const STRONG_BRIEF_INSTRUCTION =
  "사용자가 명시적으로 짧은 답을 요청했다 — 주제와 관계없이 1문장(최대 120자 정도)으로만 답하라. "
  + "목록, 배경 설명, 부가 질문 없이 핵심만 말하라.";

const LEAD_WITH_ANSWER_INSTRUCTION =
  "먼저 핵심 답을 한두 문장으로 말하고 시작하라 — 배경 설명이나 목록으로 시작하지 마라. "
  + "필요하면 답 끝에 \"더 자세히 알려줄까?\"처럼 확장 여부만 물어라.";

// A question ABOUT the assistant itself (who/what are you, who made you,
// where you run, a vendor-name challenge, "자기소개"). The identity core
// (packages/prompts identity-core.ts, the identity battery its guard) OWNS
// these turns; the light lead-with-answer nudge must NOT compete with it —
// "lead with the direct answer" nudged the model to open with the locality
// fact and drop the required 뮤즈/Muse mention, flaking the identity battery
// on cloud-data-ko. Requires a second-person self-reference (너/네/니/당신/
// you) OR a vendor-self-name OR "자기소개" OR a data-locality ask, so an
// ordinary factual "who made Docker" (no self-reference) is unaffected.
const SELF_REFERENTIAL_KO_RE =
  /자기소개|(?:너|넌|네|니|당신)\s*(?:는|은|가|이)?\s*(?:누구|누가|이름|정체|무슨\s*모델|어떤\s*모델|모델이|만들었|만든|클라우드|어디서)|누가\s*(?:너|널|당신)\s*만들|내\s*데이터.{0,6}(?:어디|어디로)|(?:구글이\s*만든|Gemma\s*모델|ChatGPT|OpenAI)/iu;
const SELF_REFERENTIAL_EN_RE =
  /\bwho\s+(?:are\s+you|created\s+you|made\s+you|built\s+you)\b|\byour\s+name\b|\bare\s+you\s+(?:chatgpt|gemma|gpt|a\s+google)\b|\bwho\s+made\s+you\b/iu;

// A leading turn that states a (often false) premise and fishes for
// agreement ("지구가 평평하다는 거 너도 알지?", "1+1은 3인 것 같아, 어때?").
// The anti-sycophancy / correction machinery — not this brevity layer — owns
// these: "lead with the direct answer, keep it to one line" competes with
// the model's need to correct the premise, so cede the light nudge here too.
const AGREEMENT_BAIT_RE =
  /(?:너도|당신도)\s*(?:알지|알잖아|그렇지|그치|맞지)|(?:맞지|그렇지|그치|안\s?그래|어때)\s*[?？]|내\s*생각(?:엔|에는)|(?:같아|같은데)\s*[.?？]|,\s*(?:맞지|그렇지|그치)\b|\b(?:right|isn'?t it|don'?t you (?:agree|think))\s*\?/iu;

function defersToHonestyOrIdentityCore(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return (
    SELF_REFERENTIAL_KO_RE.test(trimmed) ||
    SELF_REFERENTIAL_EN_RE.test(trimmed) ||
    AGREEMENT_BAIT_RE.test(trimmed)
  );
}

export const LANGUAGE_MIRROR_LAYER_ID = "personalization/language-mirror";
// Dynamic-section tone-hint, just ahead of the 반말/존댓말 register layer so the
// language directive is read first on the rare turn that carries both.
export const LANGUAGE_MIRROR_LAYER_PRIORITY = 48;

const LANGUAGE_MIRROR_INSTRUCTION =
  "사용자가 한국어가 아닌 언어(영어 등)로 말했다 — 한국어로 바꾸지 말고, 사용자가 쓴 그 언어로 처음부터 끝까지 답하라. "
  + "The user wrote in a non-Korean language; reply entirely in that same language and do not switch to Korean partway through.";

/**
 * Build the language-mirroring dynamic layer for the CURRENT turn, or
 * `undefined` when the user is writing in Korean (the default — no instruction
 * needed). The identity block carries only a soft "follow the user's language"
 * line, which a Korean-primed 12B ignores on a self-referential English turn
 * (measured live: "What can you do for me?" answered fully in Korean, and
 * "Summarize … in 3 bullets" switched to Korean mid-answer). This layer makes
 * that deterministic.
 *
 * TWO signals, both required, so a Korean question that merely name-drops
 * English tech terms ("React랑 Vue 비교", "이거 영어로 번역해줘") stays Korean:
 *   1. NO Hangul at all — any 가-힣 means the user is speaking Korean and wants
 *      a Korean reply, regardless of how many Latin tech-tokens ride along.
 *   2. Latin is the DOMINANT script — targets English (the measured leak) and
 *      not a han/kana/symbol-only turn, which this layer deliberately leaves at
 *      the Korean default.
 */
export function buildLanguageMirrorLayer(userText: string): PromptLayer | undefined {
  const trimmed = userText.trim();
  if (trimmed.length === 0 || HANGUL_RE.test(trimmed)) {
    return undefined;
  }
  if (dominantScriptFamily(trimmed) !== "latin") {
    return undefined;
  }
  return {
    content: LANGUAGE_MIRROR_INSTRUCTION,
    id: LANGUAGE_MIRROR_LAYER_ID,
    priority: LANGUAGE_MIRROR_LAYER_PRIORITY,
    section: "dynamic"
  };
}

export interface RegisterBrevityLayerInput {
  readonly userText: string;
  /** From `persona.md`'s `register` frontmatter — WINS over detection when set. */
  readonly personaRegister?: PersonaRegister;
}

/**
 * Pick the brevity/lead-with-answer line for the current turn, or
 * `undefined` when none applies. Three mutually-exclusive cases, checked in
 * priority order:
 *   (a) an explicit brief-request ("한 줄로만", "짧게: …") → the STRONG
 *       instruction — this must beat the model's default verbosity even on
 *       a turn that also happens to read as casual.
 *   (b) a casual/small-talk turn (existing behavior) → the gentle
 *       casual-brevity instruction.
 *   (c) neither (a) nor (b), NOT an explicit detail-request, and NOT a turn
 *       the honesty/identity core owns → the LIGHT lead-with-answer nudge
 *       (the simple-factual-question fix).
 * An explicit detail-request ("자세히", "단계별", "예제와 함께", …) suppresses
 * ALL THREE — the user's own request for depth always wins, however short
 * the sentence otherwise looks. This is the anti-truncation guard. A
 * self-referential identity question or a premise-challenge agreement-bait
 * suppresses the light nudge (but not an explicit brief-request) so the
 * identity / anti-sycophancy core, not this layer, shapes those turns.
 */
function selectBrevityLine(userText: string): string | undefined {
  if (detectDetailRequest(userText)) {
    return undefined;
  }
  if (detectBrevityRequest(userText)) {
    return STRONG_BRIEF_INSTRUCTION;
  }
  if (classifyCasualTurn(userText)) {
    return BREVITY_INSTRUCTION;
  }
  if (defersToHonestyOrIdentityCore(userText)) {
    return undefined;
  }
  return LEAD_WITH_ANSWER_INSTRUCTION;
}

/**
 * Build the register-mirroring + brevity dynamic layer for the CURRENT
 * turn's user text, or `undefined` when neither signal applies (nothing to
 * add). An explicit persona.md register always wins over per-turn
 * detection; detection only fills in when persona.md has no opinion
 * (absent file or "unknown" — no Hangul / no ending signal).
 */
export function buildRegisterBrevityLayer(input: RegisterBrevityLayerInput): PromptLayer | undefined {
  const detected = detectKoreanRegister(input.userText);
  const effectiveRegister = input.personaRegister ?? (detected === "unknown" ? undefined : detected);
  const brevityLine = selectBrevityLine(input.userText);

  if (!effectiveRegister && !brevityLine) {
    return undefined;
  }

  const lines = [
    ...(effectiveRegister ? [REGISTER_INSTRUCTION[effectiveRegister]] : []),
    ...(brevityLine ? [brevityLine] : [])
  ];

  return {
    content: lines.join("\n"),
    id: REGISTER_BREVITY_LAYER_ID,
    priority: REGISTER_BREVITY_LAYER_PRIORITY,
    section: "dynamic"
  };
}
