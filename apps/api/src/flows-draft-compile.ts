/**
 * Pure compile seam for `POST /api/flows/draft` (코파일럿 초안): prompt
 * construction + response parsing, no Fastify, no model call. Kept separate
 * from `flows-draft-routes.ts` so the prompt shape and the parse/validate
 * contract are unit-tested without a fake HTTP server, mirroring
 * `flow-edit-compile.ts`'s "compile seam" pattern on the web side.
 *
 * The model must answer with ONLY a JSON object matching `FlowDraftPayload`;
 * everything else here is deterministic validation against the REAL
 * scheduler contract (`@muse/scheduler`'s `validateCronExpression` /
 * `computeNextRunAt`) — never a second, looser grammar.
 */

import { extractFirstJsonObject } from "@muse/agent-core";
import { computeNextRunAt } from "@muse/scheduler";

export interface FlowDraftPayload {
  readonly name: string;
  readonly cronExpression: string;
  readonly prompt: string;
  readonly notifyChannel: string | null;
  readonly retry: boolean;
}

export interface FlowDraftPrompt {
  readonly system: string;
  readonly user: string;
}

const RESPONSE_SCHEMA_LINE =
  'Respond with ONLY a single JSON object, no prose, no code fence: {"name": string, "cronExpression": string (5-field cron: minute hour day month weekday), "prompt": string, "notifyChannel": string|null, "retry": boolean}.';

const FEW_SHOT_EXAMPLES = `Example 1
Input: 매일 아침 9시에 일정 요약해서 알려줘
Output: {"name": "아침 일정 요약", "cronExpression": "0 9 * * *", "prompt": "오늘 일정을 요약해서 알려줘", "notifyChannel": null, "retry": false}

Example 2
Input: every monday at 9am summarize my week and send it to telegram:555
Output: {"name": "Weekly summary", "cronExpression": "0 9 * * 1", "prompt": "Summarize my week", "notifyChannel": "telegram:555", "retry": false}`;

/** The system+user pair for the FIRST generation attempt. */
export function buildFlowDraftPrompt(text: string): FlowDraftPrompt {
  return {
    system: `You turn a one-line description of a recurring automation into a scheduled-job draft.\n${RESPONSE_SCHEMA_LINE}\n\n${FEW_SHOT_EXAMPLES}`,
    user: `Input: ${text}\nOutput:`
  };
}

/** The system+user pair for the ONE deterministic repair retry after an
 * invalid first response — re-prompts with the exact validation failure so
 * the model corrects the specific field, not a fresh guess. */
export function buildFlowDraftRepairPrompt(text: string, previousRaw: string, validationError: string): FlowDraftPrompt {
  const base = buildFlowDraftPrompt(text);
  return {
    system: base.system,
    user: `Input: ${text}\nYour previous answer was invalid: ${validationError}\nPrevious answer: ${previousRaw}\nReturn ONLY the corrected JSON object matching the schema above.\nOutput:`
  };
}

export type FlowDraftParseResult =
  | { readonly ok: true; readonly value: FlowDraftPayload }
  | { readonly ok: false; readonly error: string };

const CRON_FIELD_SHAPE_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/u;

/** Parses + validates a raw model completion against `FlowDraftPayload`.
 * Never throws — every failure returns a human-readable `error` describing
 * exactly what failed, which the route re-feeds into the repair retry (or,
 * on a second failure, returns verbatim in the 422 body). */
export function parseFlowDraftResponse(raw: string): FlowDraftParseResult {
  const candidate = extractFirstJsonObject(raw);
  if (!candidate) {
    return { error: "model response did not contain a JSON object", ok: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { error: "model response's JSON object failed to parse", ok: false };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "model response was not a JSON object", ok: false };
  }

  const record = parsed as Record<string, unknown>;

  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name.length === 0) {
    return { error: "name must be a non-empty string", ok: false };
  }

  const cronExpression = typeof record.cronExpression === "string" ? record.cronExpression.trim() : "";
  if (!CRON_FIELD_SHAPE_RE.test(cronExpression)) {
    return { error: "cronExpression must be a 5-field cron expression (minute hour day month weekday)", ok: false };
  }
  try {
    computeNextRunAt({ cronExpression, timezone: "UTC" });
  } catch {
    return { error: `cronExpression is not a valid cron expression: ${cronExpression}`, ok: false };
  }

  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (prompt.length === 0) {
    return { error: "prompt must be a non-empty string", ok: false };
  }

  const notifyChannel = record.notifyChannel === null || record.notifyChannel === undefined
    ? null
    : typeof record.notifyChannel === "string" && record.notifyChannel.trim().length > 0
      ? record.notifyChannel.trim()
      : null;

  const retry = typeof record.retry === "boolean" ? record.retry : false;

  return { ok: true, value: { cronExpression, name, notifyChannel, prompt, retry } };
}
