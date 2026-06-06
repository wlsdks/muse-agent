/**
 * Past-tense task-completion intent for the chat surface. The local model only
 * calls `tasks.complete` on an IMPERATIVE ("완료로 표시해줘") — a natural REPORT
 * that the user finished something ("빨래 다 했어") it just acknowledges, leaving
 * the task open forever. These pure helpers let runLocalChat detect that report
 * and mark the matching task done deterministically (tasks.complete is
 * reversible — it keeps a `done` record — so a precise auto-complete is safe and
 * far more useful than silence).
 */

/**
 * True when the message REPORTS finishing a task — a past-tense completion
 * ("다 했어 / 끝냈어 / 완료했어 / done"), NOT a question, NOT a negation/almost
 * ("거의 / 아직 / 안 했어"), and NOT an add/list/other request. Precision-first:
 * a miss costs nothing (the normal path still runs), a false positive could
 * complete a task the user didn't finish.
 */
export function isTaskCompletionReport(message: string): boolean {
  const m = message.trim();
  if (m.length === 0 || m.length > 80) return false;
  if (/[?？]/u.test(m)) return false;
  // Negation / not-yet — "거의 다 했어" (almost), "아직 안 했어" (not yet).
  if (/거의|아직|못\s|못했|안\s?했|덜\s|하는\s?중|해야|할\s?거|할게|할래/u.test(m)) return false;
  // A different intent that merely contains a completion-ish word.
  if (/추가|보여|목록|알려|삭제|지워|제거|변경|수정|뭐\b|뭐가|언제|어디|얼마/u.test(m)) return false;
  return /(다\s*했|끝냈|끝났|마쳤|마침|완료\s*(했|함|임|이야|야|됐|되었|했어)|처리\s*했|체크\s*했|\bdone\b|finished|completed)/iu.test(m);
}

const TITLE_STOPWORDS = new Set([
  "오늘", "내일", "모레", "어제", "이번", "다음", "지금", "방금", "이제", "할일", "todo", "task", "테스트", "test"
]);

/**
 * The index of the ONE open task the completion report is about, or null when
 * there is no match OR it is ambiguous (≥2 tasks match — never guess which).
 * A task matches when a distinctive word (≥2 chars, not a stopword) of its
 * TITLE appears in the message.
 */
export function matchCompletedTask(message: string, openTitles: readonly string[]): number | null {
  const m = message.toLowerCase();
  const hits: number[] = [];
  openTitles.forEach((title, index) => {
    const words = title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 2 && !TITLE_STOPWORDS.has(word));
    if (words.some((word) => m.includes(word))) hits.push(index);
  });
  return hits.length === 1 ? hits[0]! : null;
}
