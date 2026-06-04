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
export function detectDateQuery(query: string): string | null {
  const trimmed = query.trim().replace(/[?.!\s]+$/u, "");
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
  const dateStr = date.toLocaleDateString("en-US", { day: "numeric", month: "long", weekday: "long", year: "numeric" });
  const timeStr = opts?.includeTime ? `, ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "";
  const label = phrase === "today" ? "Today" : phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return `${label} is ${dateStr}${timeStr}.`;
}

/** Whether the phrase explicitly named a time (so the answer should show it), e.g. "tomorrow at 6pm". */
export function phraseHasTime(phrase: string): boolean {
  return /\b(?:at\s+\d|\d\s*(?:am|pm)|\d{1,2}:\d{2}|noon|midnight|morning|afternoon|evening|tonight)\b/iu.test(phrase);
}
