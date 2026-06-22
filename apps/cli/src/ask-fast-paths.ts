/**
 * Deterministic non-RAG short-circuit constants for `muse ask` — the
 * on-brand replies a pure social / capability / action prompt gets
 * BEFORE any retrieval or model call. Pulled out of the command handler
 * so they can be unit-tested directly.
 */

import { classifyActionRequest, classifyCasualPrompt, classifyMetaPrompt, type CasualPromptKind } from "@muse/agent-core";
import { evaluateArithmeticExpression } from "@muse/mcp";
import { parseReminderDueAt } from "@muse/stores";

import { detectArithmeticQuery, formatArithmeticResult } from "./arithmetic-query.js";
import { detectDateQuery, formatDateAnswer, phraseHasTime } from "./date-query.js";
import { countdownDays, detectCountdownQuery, formatCountdown } from "./countdown-query.js";
import { detectDateDiffQuery, formatDateDiff } from "./date-diff-query.js";
import { convertUnit, detectUnitConversion, formatConversion } from "./unit-conversion.js";
import { detectPercentageQuery, formatPercentage } from "./percentage-query.js";
import { detectTimezoneQuery, formatTimezone } from "./timezone-query.js";

// Instant, on-brand replies for a PURE social prompt — so a bare "hi" / "thanks"
// gets a clean conversational line instead of the empty-corpus on-ramp + a
// fabricated `[action: …]` citation + a "treat as unverified" grounding warning.
// Deterministic (no model call, no retrieval), so it is also the fastest path.
export const CASUAL_RESPONSES: Record<CasualPromptKind, string> = {
  farewell: "Take care — I'll be here when you need your notes.",
  greeting: "Hi! I answer from your own notes — ask me anything you've saved and I'll quote the source, or tell you honestly when it isn't there.",
  thanks: "You're welcome."
};

// An ACCURATE, honest description of what Muse actually does — so a "what can
// you do?" question doesn't make the local model free-compose an OVER-CLAIMED
// answer ("I can manage your schedule…") that then gets a grounding warning.
// Honesty about its OWN capabilities is the same edge as honesty about recall.
export const META_RESPONSE =
  "I answer questions from your own notes and quote the exact source — and I tell you \"I'm not sure\" instead of guessing. " +
  "Everything runs locally on your machine; nothing leaves. " +
  "Add notes with `muse read <file> --save-to-notes <id>`, then ask me anything you've saved — or run `muse demo` to see a cited answer and an honest refusal in about 30 seconds.";

// Honest guide for an action request on the chat-only path — so Muse never says
// "I'll remind you…" without actually doing it (a false promise).
export const ACTION_GUIDE =
  "That's something to DO, not a question — and on this path I can only read and answer, so I won't pretend to have done it. " +
  "Re-run with `--with-tools` and I'll actually do it (I show the exact action and ask before any outbound send or change). " +
  "Reads stay silent; writes/sends always ask first.";

/**
 * A deterministic fast-path hit: the exact text answer plus the JSON
 * payload the `--json` branch prints. The caller picks one by `options.json`
 * — keeping the same text-vs-JSON output split the inline handler had.
 */
export interface DeterministicAnswer {
  readonly answer: string;
  readonly jsonPayload: Record<string, unknown>;
}

/**
 * Only the `AskOptions` fields the deterministic dispatch reads. Narrowed so
 * this resolver doesn't pull the whole command's option surface.
 */
export interface DeterministicAnswerOptions {
  readonly withTools?: boolean;
}

/**
 * The ~10 deterministic non-RAG short-circuits `muse ask` tries BEFORE any
 * retrieval or model call — social / arithmetic / date / countdown / date-diff
 * / unit / percentage / timezone / meta / action. Each follows the same
 * detect→if-hit→format shape; the local 8B is confidently wrong on the
 * numeric/date ones, so Muse computes them exactly instead. Returns the first
 * hit (text + JSON payload) or null to fall through to the normal recall path.
 *
 * Order is significant and preserved from the original handler: casual first
 * (fastest), then the numeric/date computers, then meta, then the action guide.
 * The action guide only fires on the chat-only path (`!withTools`), since
 * `--with-tools` really performs the action.
 */
export function tryDeterministicAnswer(
  query: string,
  options: DeterministicAnswerOptions
): DeterministicAnswer | null {
  const casualKind = classifyCasualPrompt(query);
  if (casualKind) {
    const reply = CASUAL_RESPONSES[casualKind];
    return { answer: reply, jsonPayload: { answer: reply, casual: casualKind, query } };
  }

  const arithmeticExpression = detectArithmeticQuery(query);
  if (arithmeticExpression) {
    const evaluated = evaluateArithmeticExpression(arithmeticExpression);
    if ("result" in evaluated) {
      const answer = formatArithmeticResult(arithmeticExpression, evaluated.result);
      return { answer, jsonPayload: { answer, arithmetic: { expression: arithmeticExpression, result: evaluated.result }, query } };
    }
  }

  const datePhrase = detectDateQuery(query);
  if (datePhrase !== null) {
    const resolved = parseReminderDueAt(datePhrase, () => new Date());
    if (!(resolved instanceof Error)) {
      const answer = formatDateAnswer(datePhrase, resolved, { includeTime: phraseHasTime(datePhrase) });
      return { answer, jsonPayload: { answer, date: { iso: resolved, phrase: datePhrase }, query } };
    }
  }

  const countdown = detectCountdownQuery(query);
  if (countdown) {
    const now = new Date();
    const resolved = parseReminderDueAt(countdown.targetPhrase, () => now);
    if (!(resolved instanceof Error)) {
      const days = countdownDays(now, resolved);
      if (days >= 0) {
        const answer = formatCountdown(countdown.unit, days, resolved, countdown.ko);
        return { answer, jsonPayload: { answer, countdown: { days, target: resolved, unit: countdown.unit }, query } };
      }
    }
  }

  const dateDiff = detectDateDiffQuery(query, new Date());
  if (dateDiff) {
    const answer = formatDateDiff(dateDiff);
    return { answer, jsonPayload: { answer, dateDiff: { days: dateDiff.days, from: dateDiff.from.toISOString(), to: dateDiff.to.toISOString(), unit: dateDiff.unit }, query } };
  }

  const conversion = detectUnitConversion(query);
  if (conversion) {
    const result = convertUnit(conversion.value, conversion.from, conversion.to);
    if (result !== null) {
      const answer = formatConversion(conversion.value, conversion.from, conversion.to, result);
      return { answer, jsonPayload: { answer, conversion: { ...conversion, result }, query } };
    }
  }

  const percentage = detectPercentageQuery(query);
  if (percentage) {
    const answer = formatPercentage(percentage);
    return { answer, jsonPayload: { answer, percentage, query } };
  }

  const timezone = detectTimezoneQuery(query);
  if (timezone) {
    const answer = formatTimezone(timezone, new Date());
    return { answer, jsonPayload: { answer, timezone, query } };
  }

  if (classifyMetaPrompt(query)) {
    return { answer: META_RESPONSE, jsonPayload: { answer: META_RESPONSE, meta: true, query } };
  }

  if (!options.withTools && classifyActionRequest(query)) {
    return { answer: ACTION_GUIDE, jsonPayload: { actionRequest: true, needsTools: true, query } };
  }

  return null;
}
