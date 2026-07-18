/**
 * Chat-automation honesty post-pass — closes the false-done gap where the
 * chat surface (no scheduling capability of its own) tells the user it
 * registered a RECURRING automation ("규칙을 등록해둘게") when the Builder
 * (Flows view, `flow-draft-composer.tsx`) is the only place a recurring
 * automation is actually created. Deterministic (no model call): detect the
 * user's recurring-automation ask, detect a false registration claim in the
 * model's reply, and either correct the reply or steer the user to the
 * Builder — never silently pass a false "done" through.
 *
 * Both detectors are intentionally conservative (precision over recall): a
 * missed detection just leaves today's behavior unchanged, but a false
 * positive would incorrectly flag/correct an unrelated reply, which is the
 * worse failure mode for a user-facing honesty notice.
 */

// A recurring-cadence signal: 매일/매주/매달/매시간, 평일/주말, "<time-of-day>마다",
// "N분마다"/"N시간마다", or the English every-X / daily/weekly/hourly/monthly forms.
const RECURRING_SIGNAL_KO =
  /(매일|매주|매달|매월|매시간|평일(?:에)?|주말(?:에)?|(?:아침|저녁|밤|점심|새벽)마다|\d+\s*(?:분|시간)\s*마다)/u;
const RECURRING_SIGNAL_EN =
  /\b(?:daily|weekly|hourly|monthly|every\s+(?:day|week|month|hour|morning|evening|night|weekday|weekend))\b/iu;

// A request verb — the ask must be imperative-ish, not a passing statement.
const REQUEST_VERB_KO = /(만들|등록|설정|자동화|해줘|줘|알려|보내|요약)/u;
const REQUEST_VERB_EN = /\b(?:set\s*up|create|schedule|remind|send|summarize|make)\b/iu;

/**
 * True when the user asks to set up a RECURRING automation — a recurring-
 * cadence signal AND a request verb both present. A one-shot future ask
 * ("내일 8시에 알려줘") or a plain statement about an existing routine ("나는
 * 매일 아침 커피 마셔") is FALSE: chat already handles one-shot reminders, and a
 * statement carries no request verb.
 */
export function detectRecurringAutomationIntent(userText: string): boolean {
  const hasRecurringSignal = RECURRING_SIGNAL_KO.test(userText) || RECURRING_SIGNAL_EN.test(userText);
  if (!hasRecurringSignal) {
    return false;
  }
  return REQUEST_VERB_KO.test(userText) || REQUEST_VERB_EN.test(userText);
}

// A bare completion verb ("등록했", "만들어뒀", …) also confirms an ordinary
// ONE-TIME task/event/reminder ("치과 예약을 등록했습니다") — a real, correctly
// backed action this module must NOT flag. So every completion-verb match
// below is anchored to an automation-context noun (규칙/자동화/반복 —
// "rule"/"automation"/"recurring") within the same clause; a claim with no
// such noun nearby is a normal single-item confirmation, not this module's
// concern.
const AUTOMATION_NOUN_KO = "(?:규칙|자동화|반복)";
const COMPLETION_VERB_KO =
  "(?:등록해뒀|등록했|등록해둘게|등록해놨|만들어뒀|만들어놨|설정해뒀|설정해놨|설정해놓|추가했|추가해뒀|추가해둘게|예약해뒀|예약했)";
const FALSE_CLAIM_KO = new RegExp(
  `(?:${AUTOMATION_NOUN_KO}[^.!?\\n]{0,12}${COMPLETION_VERB_KO}` +
    `|${COMPLETION_VERB_KO}[^.!?\\n]{0,12}${AUTOMATION_NOUN_KO}` +
    // These two are self-anchored (the noun IS the registration target), so
    // no separate automation-noun proximity check is needed.
    `|스케줄에\\s*(?:추가|등록)` +
    `|규칙을\\s*등록)`,
  "u"
);
const FALSE_CLAIM_KO_RECURRING_PROMISE = /매일[^.!?\n]{0,20}(?:보내|알려)[^.!?\n]{0,6}드릴게/u;
const FALSE_CLAIM_EN =
  /\bI(?:'ve| have)\s+(?:set\s*up|scheduled|registered|created)\b[^.!?\n]{0,30}\b(?:rule|schedule|automation)\b/iu;

/**
 * True when the ASSISTANT reply claims to have registered, or promises a
 * recurring delivery of, a schedule/automation/rule it has no way to
 * actually create from chat. Plain helpful text — including a future-tense
 * OFFER ("빌더에서 만들어 드릴 수 있어요"), a report of an existing calendar item,
 * or an ordinary ONE-TIME task/event registration claim ("치과 예약을
 * 등록했습니다") — is FALSE; only a completed/promised RECURRING-automation
 * claim counts.
 */
export function detectFalseSchedulingClaim(replyText: string): boolean {
  return (
    FALSE_CLAIM_KO.test(replyText) ||
    FALSE_CLAIM_KO_RECURRING_PROMISE.test(replyText) ||
    FALSE_CLAIM_EN.test(replyText)
  );
}

export const AUTOMATION_CORRECTION_BLOCK_KO =
  "정정: 방금 답변은 정확하지 않아요 — 채팅에서는 반복 자동화(매일/매주 등 규칙)를 실제로 등록할 수 없어요. 빌더(자동화 화면)에서 만들어 드릴 수 있어요.";

export const AUTOMATION_GUIDANCE_BLOCK_KO =
  "참고: 반복 자동화는 채팅에서 바로 등록되지 않아요 — 빌더(자동화 화면)에서 만들 수 있어요.";

export interface ApplyAutomationHonestyInput {
  readonly userText: string;
  readonly replyText: string;
}

export interface ApplyAutomationHonestyResult {
  readonly content: string;
  /** The user's original ask, for the Builder copilot composer seed — null when no automation context applies. */
  readonly builderHint: string | null;
}

/**
 * Deterministic post-pass over a chat turn: a false registration claim is
 * corrected (wins over guidance — the user was just told something untrue),
 * an honest recurring-automation ask with no false claim gets a one-line
 * Builder pointer, and anything else passes through UNCHANGED (byte-
 * identical, so this is a no-op on the vast majority of chat turns).
 */
export function applyAutomationHonesty(input: ApplyAutomationHonestyInput): ApplyAutomationHonestyResult {
  const { userText, replyText } = input;
  if (detectFalseSchedulingClaim(replyText)) {
    return { builderHint: userText, content: `${replyText}\n\n${AUTOMATION_CORRECTION_BLOCK_KO}` };
  }
  if (detectRecurringAutomationIntent(userText)) {
    return { builderHint: userText, content: `${replyText}\n\n${AUTOMATION_GUIDANCE_BLOCK_KO}` };
  }
  return { builderHint: null, content: replyText };
}
