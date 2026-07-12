/**
 * Deterministic fact-candidate backstop for `memory-auto-extract.ts`.
 *
 * User-sim audit finding (CONFIRMED): an explicit remember-request buried
 * inside a long, rambling, polite message ("우리 딸 생일이 다음달 5일인데
 * 자꾸 까먹을까봐 걱정이예요 ... 꼭 기억했다가 알려줄수 있어요?") produced NO
 * fact — the LLM auto-extract pass drops key items in long-form text even
 * though the same request phrased tersely extracts fine.
 *
 * When the user's turn carries an explicit commit marker (기억해 / 잊지 마 /
 * 까먹 / remember / don't forget), {@link extractDeterministicFactCandidates}
 * runs a small set of deterministic regex patterns over that SAME turn.
 * The caller merges the result into the model's extraction ADDITIVELY
 * ({@link mergeFactBackstop}) — a key the model already produced keeps the
 * model's value; the backstop only fills gaps the model dropped.
 */

const COMMIT_MARKER_RE = /기억해|잊지\s?마|까먹|remember|don't forget/iu;

/** Whether `text` contains an explicit "remember this" commit marker. */
export function hasCommitMarker(text: string): boolean {
  return COMMIT_MARKER_RE.test(text);
}

const RELATION_KEY_BY_NOUN: Readonly<Record<string, string>> = {
  "딸": "daughter",
  "아들": "son",
  "엄마": "mother",
  "아빠": "father",
  "남편": "husband",
  "아내": "wife",
  "친구": "friend"
};

// Relation noun ... 생일 ... date. The date half only matches an ABSOLUTE
// or next-month-relative day expression (다음달 N일 / N월 N일) — never a
// same-day-relative phrase, so it can't collide with the ephemeral-value
// guard in memory-ephemeral-value-guard.ts.
const RELATION_BIRTHDAY_RE =
  /(딸|아들|엄마|아빠|남편|아내|친구)[^\n]{0,6}생일[^\n]{0,20}?((?:다음\s?달|\d{1,2}\s?월)\s?\d{1,2}\s?일)/u;

/**
 * Resolve a "다음달 N일" (relative — goes stale a month later) into an
 * absolute "M월 N일" anchored at `now`. "N월 N일" is already absolute and
 * passes through unchanged. Returns the raw phrase unresolved only if it
 * doesn't match either recognized shape (defensive — `RELATION_BIRTHDAY_RE`
 * guarantees one of them today).
 */
function resolveBirthdayDate(raw: string, now: Date): string {
  const compact = raw.replace(/\s+/gu, "");
  const nextMonthMatch = /^다음달(\d{1,2})일$/u.exec(compact);
  if (!nextMonthMatch) {
    return raw;
  }
  const day = Number.parseInt(nextMonthMatch[1] ?? "", 10);
  if (!Number.isFinite(day) || day < 1 || day > 31) {
    return raw;
  }
  const nextMonthIndex = (now.getMonth() + 1) % 12;
  // Drop-not-guess, matching followup-detector's buildValid precedent: a day
  // the resolved month doesn't have (다음달 31일 said before a 30-day month)
  // must keep the raw phrase — persisting "4월 31일" would be a fabricated
  // durable fact that JS Date consumers silently roll to another day.
  const yearRoll = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const candidate = new Date(yearRoll, nextMonthIndex, day);
  if (candidate.getDate() !== day || candidate.getMonth() !== nextMonthIndex) {
    return raw;
  }
  return `${nextMonthIndex + 1}월 ${day}일`;
}

// "내 이름은 X" / "나 X야" self-introduction patterns. Lazy quantifier so
// the euphonic copula (이야/야) doesn't get absorbed into the captured name.
const NAME_PATTERNS: readonly RegExp[] = [
  /내\s?이름은\s?([가-힣]{2,10}?)(?:이야|야|이에요|예요|입니다|이라고|[\s.,!?]|$)/u,
  /나\s+([가-힣]{2,10}?)(?:이야|야)/u
];

const PREFERENCE_RE = /([가-힣]{1,20}?)(?:을|를)?\s*(좋아해|싫어해)/u;

/**
 * Deterministic candidate extraction, gated on {@link hasCommitMarker} —
 * returns `{}` when the turn carries no explicit "remember this" signal
 * so the backstop never fires on ordinary chat.
 */
export function extractDeterministicFactCandidates(
  userPrompt: string,
  options: { readonly now?: Date } = {}
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!userPrompt || !hasCommitMarker(userPrompt)) {
    return out;
  }
  const now = options.now ?? new Date();

  const birthdayMatch = RELATION_BIRTHDAY_RE.exec(userPrompt);
  if (birthdayMatch) {
    const relationKey = RELATION_KEY_BY_NOUN[birthdayMatch[1] ?? ""];
    const date = (birthdayMatch[2] ?? "").trim();
    if (relationKey && date) {
      // FIX N5b: a relative "다음달 N일" stored VERBATIM goes stale the
      // moment the calendar rolls over — resolve to the absolute month at
      // extraction time so recall never speaks a date that used to be
      // "next month" but no longer is.
      out[`${relationKey}_birthday`] = resolveBirthdayDate(date, now);
    }
  }

  for (const pattern of NAME_PATTERNS) {
    const match = pattern.exec(userPrompt);
    const name = match?.[1]?.trim();
    if (name) {
      out.user_name = name;
      break;
    }
  }

  const preferenceMatch = PREFERENCE_RE.exec(userPrompt);
  if (preferenceMatch) {
    const item = (preferenceMatch[1] ?? "").trim();
    const verb = preferenceMatch[2];
    if (item) {
      out[verb === "좋아해" ? "likes_item" : "dislikes_item"] = item;
    }
  }

  return out;
}

/**
 * Additive merge: a backstop candidate is added ONLY for a key the
 * model's own extraction did not already produce. A model-extracted
 * value for the same key — typically richer / more precise — always
 * wins; the backstop never overwrites it.
 */
export function mergeFactBackstop(
  modelFacts: Readonly<Record<string, string>> | undefined,
  candidates: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = { ...(modelFacts ?? {}) };
  for (const [key, value] of Object.entries(candidates)) {
    if (!(key in out)) {
      out[key] = value;
    }
  }
  return out;
}
