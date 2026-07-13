/**
 * The golden set for TEACHING-SIGNAL detection — the funnel every learning
 * surface eats from.
 *
 * `detectCorrections` was built precision-first around explicit error markers
 * ("아니야", "that's wrong", "틀렸어"). Measured against the turns a real user
 * actually types after an answer they did not like, it recalls **3 of 15**. The
 * other twelve — "결론부터 말해줘", "더 짧게", "표로 정리해줘", "be more concise" —
 * are the ordinary way people teach an assistant, and every one of them was
 * discarded in silence. Since this detector is the sole feed for distillation,
 * credit assignment and decay, its recall is a hard ceiling on the whole
 * self-improving loop: 20% in, at best 20% learned.
 *
 * The missing class is not a correction, it is a REDIRECT: the user restates
 * HOW they wanted the previous answer, without ever saying it was wrong.
 * (PRELUDE, arXiv:2404.15269, makes the same point — the user's edit, not their
 * error declaration, is the richest preference signal there is.)
 *
 * A redirect is distinguished from a NEW REQUEST by what it is about: a redirect
 * talks about the FORM of the answer just given; a new request opens a new topic.
 * "표로 정리해줘" right after an answer is a redirect. "내일 회의 잡아줘" is not.
 * That distinction is the whole problem, and it is what this set grades.
 *
 * Cases are graded on the USER turn in position 3 of an
 * (ask → answer → this turn) exchange. `teaches: true` means the turn must
 * reach the distiller; `false` means it must not, because a false positive
 * writes a junk rule into the user's playbook and junk rules are worse than no
 * rules — they get injected into every future prompt.
 */

export interface TeachingSignalCase {
  /** The user turn, spoken right after an assistant answer. */
  readonly turn: string;
  /** Must this reach the distiller? */
  readonly teaches: boolean;
  /** Why — so a failing case reads as a defect, not a mystery. */
  readonly note: string;
}

export const TEACHING_SIGNAL_GOLDEN: readonly TeachingSignalCase[] = [
  // ── redirects: the majority class, and the one that was 100% invisible ──
  { note: "answer-form directive (KO)", teaches: true, turn: "결론부터 말해줘. 서론 빼고." },
  { note: "length directive (KO)", teaches: true, turn: "더 짧게 요약해줘" },
  { note: "language directive (KO)", teaches: true, turn: "한국어로 답해줘" },
  { note: "format directive (KO)", teaches: true, turn: "표로 정리해줘" },
  { note: "content-exclusion directive (KO)", teaches: true, turn: "코드는 빼고 설명만" },
  { note: "register directive (KO)", teaches: true, turn: "존댓말 말고 편하게 말해" },
  { note: "autonomy directive (KO)", teaches: true, turn: "이런 건 물어보지 말고 그냥 해줘" },
  { note: "standing directive — 앞으로는 = applies to every future answer", teaches: true, turn: "앞으로는 링크도 같이 줘" },
  { note: "bare complaint about the answer's form", teaches: true, turn: "너무 길어" },
  { note: "specificity directive (KO)", teaches: true, turn: "그런 뻔한 말 말고 구체적으로" },
  { note: "length directive (EN)", teaches: true, turn: "be more concise" },
  { note: "standing directive (EN)", teaches: true, turn: "always cite the file path" },
  { note: "tone directive (EN)", teaches: true, turn: "skip the disclaimer next time" },

  // ── explicit corrections: the class that already worked. It must keep working. ──
  { note: "explicit error (KO)", teaches: true, turn: "아니야, 그거 틀렸어" },
  { note: "redo (KO)", teaches: true, turn: "다시 정리해줘" },
  { note: "explicit error (EN)", teaches: true, turn: "No, that's wrong" },

  // ── new requests: an imperative, but about a NEW topic. Must NOT fire. ──
  { note: "a new question, not a redirect", teaches: false, turn: "월세 얼마야?" },
  { note: "an imperative — but a new task, not a comment on the last answer", teaches: false, turn: "내일 회의 일정 잡아줘" },
  { note: "follow-up question continuing the topic — asks for more, teaches nothing", teaches: false, turn: "그럼 다음 주는 어때?" },
  { note: "an imperative on a new topic (EN)", teaches: false, turn: "send this to the team" },

  // ── acknowledgements and small talk: teach nothing. Must NOT fire. ──
  { note: "thanks — approval, not a directive (the approval path handles it)", teaches: false, turn: "고마워!" },
  { note: "acknowledgement", teaches: false, turn: "오케이 좋아" },
  { note: "greeting", teaches: false, turn: "ㅎㅎ 그렇구나" },
  { note: "an answer to Muse's own question — content, not instruction", teaches: false, turn: "응 그거 맞아, 3시로 해줘" }
];

/**
 * Cases written to ATTACK the patterns above, after they were tuned to the
 * golden set — a set you tune to is a set you overfit, so the honest number
 * comes from turns the lexicon never saw. On its first run this held-out set
 * scored 4 false positives and 2 false negatives against a golden-set score of
 * 16/16, which is exactly the gap it exists to expose.
 *
 * The two hard ones are worth naming, because they are why a regex can never be
 * the last word here:
 *
 *   "앞으로 이모지 쓰지 마"  — shapes the ANSWER. A lesson.
 *   "숙제 하지 마"          — shapes the WORLD. Not a lesson.
 *
 * Same negated imperative, opposite meaning, and only the object tells them
 * apart. The lexicon handles this pair by requiring the negated verb to be an
 * ANSWERING verb (쓰지/넣지/적지), which works — but the general case belongs to
 * the LLM gate downstream, not to a longer regex.
 */
export const TEACHING_SIGNAL_HELD_OUT: readonly TeachingSignalCase[] = [
  { note: "항상 inside a question — a mention, not a directive", teaches: false, turn: "항상 이런 식이야?" },
  { note: "절대 inside a noun (절대적인)", teaches: false, turn: "절대적인 기준이 뭐야?" },
  { note: "요약 as a noun — asking where a file is", teaches: false, turn: "요약본 어디 있어?" },
  { note: "표 as a noun — a new request for an existing table", teaches: false, turn: "그 표 좀 보여줘" },
  { note: "always in prose, no answering verb follows", teaches: false, turn: "always is a strong word" },
  { note: "a new request that merely mentions code", teaches: false, turn: "코드 리뷰 해줄래?" },
  { note: "negated imperative about the WORLD, not the answer", teaches: false, turn: "숙제 하지 마" },
  { note: "unseen manner word (쉽게), phrased as a question", teaches: true, turn: "좀 더 쉽게 설명해줄래?" },
  { note: "unseen format phrasing", teaches: true, turn: "번호 붙여서 줘" },
  { note: "unseen standing veto — negated ANSWERING verb", teaches: true, turn: "앞으로 이모지 쓰지 마" },
  { note: "unseen tone complaint, no imperative at all", teaches: true, turn: "말투가 너무 딱딱해" },
  { note: "detail directive on the answer just given", teaches: true, turn: "회의 자세히 알려줘" },
  { note: "inclusion directive", teaches: true, turn: "다음 주 일정 포함해서 보여줘" }
];
