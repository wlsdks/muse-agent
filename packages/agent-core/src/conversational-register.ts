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

export interface RegisterBrevityLayerInput {
  readonly userText: string;
  /** From `persona.md`'s `register` frontmatter — WINS over detection when set. */
  readonly personaRegister?: PersonaRegister;
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
  const casual = classifyCasualTurn(input.userText);

  if (!effectiveRegister && !casual) {
    return undefined;
  }

  const lines = [
    ...(effectiveRegister ? [REGISTER_INSTRUCTION[effectiveRegister]] : []),
    ...(casual ? [BREVITY_INSTRUCTION] : [])
  ];

  return {
    content: lines.join("\n"),
    id: REGISTER_BREVITY_LAYER_ID,
    priority: REGISTER_BREVITY_LAYER_PRIORITY,
    section: "dynamic"
  };
}
