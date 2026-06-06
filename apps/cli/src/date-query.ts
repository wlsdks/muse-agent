/**
 * `muse ask`'s pure date-arithmetic fast-path detector. The local 8B can't do
 * date arithmetic reliably (it doesn't dependably know today, and miscounts
 * forward/back), so a query that is nothing but a relative-date question
 * ("what's the date next Friday?", "what day is in 3 weeks?") should be answered
 * DETERMINISTICALLY. This file only DETECTS the question and formats the answer;
 * the actual parse goes through the reminder/task date grammar
 * (`parseReminderDueAt`), which is the precision gate — a candidate that is not a
 * clean date phrase (an event name like "my dentist appointment") fails to parse
 * and the query falls through to normal recall.
 */

const DATE_FRAMING =
  /^(?:what(?:'s|s|\s+is|\s+was|\s+will\s+be)?\s*(?:the\s+)?(?:date|day(?:\s+of\s+the\s+week)?)|what\s+day|when(?:'s|\s+is|\s+was|\s+will\s+be)|which\s+day(?:\s+of\s+the\s+week)?)\b/iu;

/**
 * Strip a date-question framing ("what's the date …", "what day is …", "when is
 * …") and return the bare date phrase to resolve — "today" when none is given
 * ("what's the date?"). Returns null when the query isn't a date question. The
 * caller still validates the phrase with `parseReminderDueAt`, so a non-date
 * remainder ("my meeting") never hijacks retrieval.
 */
// Korean date questions are SUFFIX-framed ("100일 후가 며칠이야?", "다음 주 금요일은
// 무슨 요일?") — the question word trails the phrase, the opposite of English. The
// terminal "며칠"/"무슨 요일"/"날짜" + optional particle is the marker; what precedes
// it is the date phrase parseReminderDueAt resolves. Anchored at end so a
// countdown ("크리스마스까지 며칠 남았어") — which trails with "남았어" — doesn't match.
const KO_DATE_FRAMING = /\s*(?:은|는|이|가)?\s*(?:며칠|무슨\s*요일|날짜)(?:이야|이에요|예요|인가요|인지|이지|일까|야)?$/u;

export function detectDateQuery(query: string): string | null {
  const trimmed = query.trim().replace(/[?.!\s]+$/u, "");
  if (/[가-힣]/u.test(trimmed)) {
    const ko = trimmed.replace(KO_DATE_FRAMING, "").replace(/\s*(?:은|는|이|가)\s*$/u, "").trim();
    return ko.length > 0 && ko !== trimmed ? ko : null;
  }
  const match = DATE_FRAMING.exec(trimmed);
  if (!match) {
    return null;
  }
  let rest = trimmed.slice(match[0].length).trim();
  rest = rest.replace(/^(?:is|was|will\s+be|of|be|on)\s+/iu, "").trim();
  if (rest.length === 0 || /^(?:it|now|today)$/iu.test(rest)) {
    return "today";
  }
  return rest;
}

/** "Next Friday is Friday, June 12, 2026." — the phrase + the resolved calendar date (+ time if the phrase set one). */
export function formatDateAnswer(phrase: string, iso: string, opts?: { readonly includeTime?: boolean }): string {
  const date = new Date(iso);
  // A Korean phrase ("100일 후") gets a Korean answer — the fast-path bypasses the
  // model, so an English sentence here would be jarring for a KO-primary user.
  if (/[가-힣]/u.test(phrase)) {
    const dateStr = date.toLocaleDateString("ko-KR", { day: "numeric", month: "long", weekday: "long", year: "numeric" });
    const timeStr = opts?.includeTime ? ` ${date.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })}` : "";
    // Topic-particle agreement: 은 after a final consonant (batchim), 는 otherwise.
    const lastCode = phrase.charCodeAt(phrase.length - 1) - 0xac00;
    const particle = lastCode >= 0 && lastCode <= 11171 && lastCode % 28 !== 0 ? "은" : "는";
    return `${phrase}${particle} ${dateStr}${timeStr}입니다.`;
  }
  const dateStr = date.toLocaleDateString("en-US", { day: "numeric", month: "long", weekday: "long", year: "numeric" });
  const timeStr = opts?.includeTime ? `, ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "";
  const label = phrase === "today" ? "Today" : phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return `${label} is ${dateStr}${timeStr}.`;
}

/** Whether the phrase explicitly named a time (so the answer should show it), e.g. "tomorrow at 6pm". */
export function phraseHasTime(phrase: string): boolean {
  return /\b(?:at\s+\d|\d\s*(?:am|pm)|\d{1,2}:\d{2}|noon|midnight|morning|afternoon|evening|tonight)\b/iu.test(phrase);
}
