/**
 * Pure compile seam for the Flows editor: form state <-> the EXACT scheduler
 * job HTTP payloads (`POST/PATCH /api/scheduler/jobs`). No React, no fetch —
 * every function here is deterministic and unit-tested for field-name
 * fidelity against the real server contract (`scheduler-routes.ts` /
 * `@muse/scheduler`'s `ScheduledJobInput`/`ScheduledJobUpdateInput`).
 *
 * The only executable program shape this slice compiles is
 * trigger(schedule) -> action(agent prompt) -> output(notify | record), with
 * an optional retry loop on the action — so a form built from these types
 * always compiles to a payload the server accepts; there is no freeform
 * graph-editing surface here by design.
 */

import type { FlowDraftPayloadRow, FlowEdge, FlowNode, FlowProjection, ScheduledJobCreateBody, ScheduledJobDetail, ScheduledJobPatchBody } from "../api/types.js";

export type SchedulePresetId = "dailyMorning9" | "dailyEvening6" | "hourly" | "weeklyMonday9" | "weekdays9";

export interface SchedulePreset {
  readonly id: SchedulePresetId;
  readonly cronExpression: string;
}

// Deterministic preset table — the ONLY source of truth for preset<->cron
// lookup. Labels live in i18n (`auto.flows.preset.<id>`), never here.
export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { cronExpression: "0 9 * * *", id: "dailyMorning9" },
  { cronExpression: "0 18 * * *", id: "dailyEvening6" },
  { cronExpression: "0 * * * *", id: "hourly" },
  { cronExpression: "0 9 * * 1", id: "weeklyMonday9" },
  { cronExpression: "0 9 * * 1-5", id: "weekdays9" }
];

export type ScheduleKind = SchedulePresetId | "custom";

export function cronForPreset(id: SchedulePresetId): string {
  const preset = SCHEDULE_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    // Exhaustive by construction (SchedulePresetId is the union of every
    // table id) — this only fires if the table and the type drift apart.
    throw new Error(`Unknown schedule preset: ${String(id)}`);
  }
  return preset.cronExpression;
}

export function presetForCron(cronExpression: string): ScheduleKind {
  const trimmed = cronExpression.trim();
  const match = SCHEDULE_PRESETS.find((preset) => preset.cronExpression === trimmed);
  return match?.id ?? "custom";
}

// Shape-only check (5 whitespace-separated fields) for the advanced raw-cron
// field. This is NOT a full cron grammar validator — the server
// (`validateCronExpression`, cron-parser) remains the final authority; a
// value that passes this shape check but fails server validation surfaces
// the server's own error message on save, verbatim.
const CRON_FIELD_SHAPE_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/u;

export function isValidCronShape(cronExpression: string): boolean {
  return CRON_FIELD_SHAPE_RE.test(cronExpression.trim());
}

export function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A curated set of IANA zones for the trigger's timezone picker. Offering a
 * fixed valid list (rather than free text) means the Builder can never
 * compile an invalid timezone — the scheduler evaluates the cron in this zone
 * (`computeNextRunAt` passes it to cron-parser), so a bad value would misfire
 * the schedule. */
const COMMON_TIMEZONES: readonly string[] = [
  "UTC",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Australia/Sydney"
];

/** The timezone select's options for a job currently on `currentTz`: the
 * curated set, plus the job's own zone (and the browser's local zone) if not
 * already present, so an unusual persisted timezone is never dropped from the
 * dropdown (which would silently reset it on the next save). */
export function timezoneOptions(currentTz: string): readonly string[] {
  const options = [...COMMON_TIMEZONES];
  for (const tz of [currentTz, defaultTimezone()]) {
    if (tz && tz.trim().length > 0 && !options.includes(tz)) {
      options.push(tz);
    }
  }
  return options;
}

export interface ScheduleFormState {
  readonly kind: ScheduleKind;
  readonly customCron: string;
}

export function scheduleFormFromCron(cronExpression: string): ScheduleFormState {
  const kind = presetForCron(cronExpression);
  return { customCron: kind === "custom" ? cronExpression.trim() : "", kind };
}

export function resolveScheduleCron(form: ScheduleFormState): string {
  return form.kind === "custom" ? form.customCron.trim() : cronForPreset(form.kind);
}

export const MIN_RETRY_COUNT = 1;
export const MAX_RETRY_COUNT = 5;
export const DEFAULT_MAX_RETRY_COUNT = 3;

function clampRetryCount(count: number): number {
  if (!Number.isFinite(count)) {
    return DEFAULT_MAX_RETRY_COUNT;
  }
  return Math.min(MAX_RETRY_COUNT, Math.max(MIN_RETRY_COUNT, Math.round(count)));
}

export interface TriggerEditForm {
  readonly schedule: ScheduleFormState;
  readonly timezone: string;
}

export interface ActionEditForm {
  readonly agentPrompt: string;
  readonly agentModel: string;
  readonly agentSystemPrompt: string;
  readonly retryOnFailure: boolean;
  readonly maxRetryCount: number;
}

/** Editing an existing `action.tool` node — the read-risk cascade re-points
 * server/tool and the args textarea PATCHes with them as one body. */
export interface ToolActionEditForm {
  readonly toolServerName: string;
  readonly toolName: string;
  readonly toolArgumentsText: string;
}

export type ToolArgumentsParseResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false };

/** Client-side JSON validation for the tool-arguments textarea (create AND
 * edit forms) — blank text is valid and means "no arguments" ({}); anything
 * else must parse to a JSON OBJECT (not an array/primitive). The server
 * (`readJsonObject`) remains the final authority on save. */
export function parseToolArgumentsText(text: string): ToolArgumentsParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}

export interface OutputEditForm {
  readonly notificationChannelId: string;
}

export function triggerFormFromJob(job: Pick<ScheduledJobDetail, "cronExpression" | "timezone">): TriggerEditForm {
  return { schedule: scheduleFormFromCron(job.cronExpression), timezone: job.timezone };
}

export function actionFormFromJob(
  job: Pick<ScheduledJobDetail, "agentPrompt" | "agentModel" | "agentSystemPrompt" | "retryOnFailure" | "maxRetryCount">
): ActionEditForm {
  return {
    agentModel: job.agentModel ?? "",
    agentPrompt: job.agentPrompt ?? "",
    agentSystemPrompt: job.agentSystemPrompt ?? "",
    maxRetryCount: job.retryOnFailure ? clampRetryCount(job.maxRetryCount) : DEFAULT_MAX_RETRY_COUNT,
    retryOnFailure: job.retryOnFailure
  };
}

export function outputFormFromJob(job: Pick<ScheduledJobDetail, "notificationChannelId">): OutputEditForm {
  return { notificationChannelId: job.notificationChannelId ?? "" };
}

export function toolActionFormFromJob(
  job: Pick<ScheduledJobDetail, "mcpServerName" | "toolArguments" | "toolName">
): ToolActionEditForm {
  return {
    toolArgumentsText: JSON.stringify(job.toolArguments ?? {}, null, 2),
    toolName: job.toolName ?? "",
    toolServerName: job.mcpServerName ?? ""
  };
}

export function flowEditToJobPatch(kind: "trigger", form: TriggerEditForm): ScheduledJobPatchBody;
export function flowEditToJobPatch(kind: "action", form: ActionEditForm): ScheduledJobPatchBody;
export function flowEditToJobPatch(kind: "output", form: OutputEditForm): ScheduledJobPatchBody;
export function flowEditToJobPatch(kind: "tool", form: ToolActionEditForm): ScheduledJobPatchBody;
export function flowEditToJobPatch(
  kind: "trigger" | "action" | "output" | "tool",
  form: TriggerEditForm | ActionEditForm | OutputEditForm | ToolActionEditForm
): ScheduledJobPatchBody {
  if (kind === "trigger") {
    const triggerForm = form as TriggerEditForm;
    return { cronExpression: resolveScheduleCron(triggerForm.schedule), timezone: triggerForm.timezone };
  }
  if (kind === "action") {
    const actionForm = form as ActionEditForm;
    return {
      agentModel: actionForm.agentModel.trim().length > 0 ? actionForm.agentModel.trim() : null,
      agentPrompt: actionForm.agentPrompt.trim(),
      agentSystemPrompt: actionForm.agentSystemPrompt.trim().length > 0 ? actionForm.agentSystemPrompt.trim() : null,
      maxRetryCount: clampRetryCount(actionForm.maxRetryCount),
      retryOnFailure: actionForm.retryOnFailure
    };
  }
  if (kind === "tool") {
    const toolForm = form as ToolActionEditForm;
    const parsed = parseToolArgumentsText(toolForm.toolArgumentsText);
    return {
      mcpServerName: toolForm.toolServerName.trim(),
      toolArguments: parsed.ok ? parsed.value : {},
      toolName: toolForm.toolName.trim()
    };
  }
  const outputForm = form as OutputEditForm;
  return {
    notificationChannelId: outputForm.notificationChannelId.trim().length > 0 ? outputForm.notificationChannelId.trim() : null
  };
}

export function renameFlowPatch(name: string): ScheduledJobPatchBody {
  return { name: name.trim() };
}

export function toggleEnabledPatch(enabled: boolean): ScheduledJobPatchBody {
  return { enabled };
}

export type ActionKind = "agent" | "tool";

export interface FlowDraft {
  readonly name: string;
  readonly schedule: ScheduleFormState;
  /** Which action the create form compiles: an agent prompt run, or a
   * scheduled MCP tool call. The copilot draft composer only ever produces
   * "agent" drafts today — a tool-mode draft is authored directly in the
   * form (see `FlowCreatePanel`). */
  readonly actionKind: ActionKind;
  readonly agentPrompt: string;
  readonly agentModel: string;
  readonly agentSystemPrompt: string;
  readonly toolServerName: string;
  readonly toolName: string;
  /** Raw JSON textarea value — parsed on submit via `parseToolArgumentsText`
   * (blank -> `{}`), never pre-parsed into the draft so the textarea can
   * hold invalid-but-in-progress JSON without losing keystrokes. */
  readonly toolArgumentsText: string;
  readonly notificationChannelId: string;
  readonly retryOnFailure: boolean;
  readonly maxRetryCount: number;
  readonly enabled: boolean;
}

export function emptyFlowDraft(): FlowDraft {
  return {
    actionKind: "agent",
    agentModel: "",
    agentPrompt: "",
    agentSystemPrompt: "",
    enabled: true,
    maxRetryCount: DEFAULT_MAX_RETRY_COUNT,
    name: "",
    notificationChannelId: "",
    retryOnFailure: false,
    schedule: { customCron: "", kind: "dailyMorning9" },
    toolArgumentsText: "",
    toolName: "",
    toolServerName: ""
  };
}

export function isFlowDraftValid(draft: FlowDraft): boolean {
  const scheduleValid = draft.schedule.kind !== "custom" || isValidCronShape(draft.schedule.customCron);
  if (!scheduleValid || draft.name.trim().length === 0) {
    return false;
  }
  if (draft.actionKind === "tool") {
    return draft.toolServerName.trim().length > 0
      && draft.toolName.trim().length > 0
      && parseToolArgumentsText(draft.toolArgumentsText).ok;
  }
  return draft.agentPrompt.trim().length > 0;
}

/** Exact `POST /api/scheduler/jobs` body for a new flow — an agent-prompt
 * action or a scheduled MCP tool call, never both. */
export function flowDraftToJobInput(draft: FlowDraft, timezone: string = defaultTimezone()): ScheduledJobCreateBody {
  const notificationChannelId = draft.notificationChannelId.trim();
  const shared = {
    cronExpression: resolveScheduleCron(draft.schedule),
    enabled: draft.enabled,
    maxRetryCount: clampRetryCount(draft.maxRetryCount),
    name: draft.name.trim(),
    notificationChannelId: notificationChannelId.length > 0 ? notificationChannelId : undefined,
    retryOnFailure: draft.retryOnFailure,
    timezone
  };

  if (draft.actionKind === "tool") {
    const parsedArguments = parseToolArgumentsText(draft.toolArgumentsText);
    return {
      ...shared,
      jobType: "mcp_tool",
      mcpServerName: draft.toolServerName.trim(),
      toolArguments: parsedArguments.ok ? parsedArguments.value : {},
      toolName: draft.toolName.trim()
    };
  }

  const agentModel = draft.agentModel.trim();
  const agentSystemPrompt = draft.agentSystemPrompt.trim();
  return {
    ...shared,
    agentModel: agentModel.length > 0 ? agentModel : undefined,
    agentPrompt: draft.agentPrompt.trim(),
    agentSystemPrompt: agentSystemPrompt.length > 0 ? agentSystemPrompt : undefined,
    jobType: "agent"
  };
}

/** Maps `POST /api/flows/draft`'s response into the SAME `FlowDraft` shape
 * the create form edits — the copilot draft is never auto-created, it just
 * pre-fills this form so the user still reviews + clicks 만들기. A cron the
 * model returned that matches a known preset resolves to that preset
 * (`scheduleFormFromCron`); otherwise it lands in the custom-cron field.
 * `base` (the live form on a REVISION turn) carries the fields the copilot's
 * payload cannot express — model, system prompt, retry count, enabled — so a
 * follow-up chat turn never silently wipes a manual form edit. */
export function flowDraftFromCopilot(payload: FlowDraftPayloadRow, base?: FlowDraft): FlowDraft {
  return {
    actionKind: payload.action === "tool" ? "tool" : "agent",
    agentModel: base?.agentModel ?? "",
    agentPrompt: payload.prompt,
    agentSystemPrompt: base?.agentSystemPrompt ?? "",
    enabled: base?.enabled ?? true,
    maxRetryCount: base?.maxRetryCount ?? DEFAULT_MAX_RETRY_COUNT,
    name: payload.name,
    notificationChannelId: payload.notifyChannel ?? "",
    retryOnFailure: payload.retry,
    schedule: scheduleFormFromCron(payload.cronExpression),
    toolArgumentsText:
      payload.action === "tool" && payload.toolArguments && Object.keys(payload.toolArguments).length > 0
        ? JSON.stringify(payload.toolArguments, null, 2)
        : "",
    toolName: payload.action === "tool" ? (payload.toolName ?? "") : "",
    toolServerName: payload.action === "tool" ? (payload.toolServer ?? "") : ""
  };
}

/** The inverse of `flowDraftFromCopilot` — the LIVE create-panel form state,
 * projected back into the copilot's 5-field shape. This is what a
 * conversational revision turn sends as `currentDraft`: the user's manual
 * form edits between turns must be reflected, so this reads the actual form
 * values, never the last server-returned draft. */
export function flowDraftToCopilotPayload(draft: FlowDraft): FlowDraftPayloadRow {
  const notifyChannel = draft.notificationChannelId.trim();
  const isTool = draft.actionKind === "tool";
  const parsedArguments = isTool ? parseToolArgumentsText(draft.toolArgumentsText) : undefined;
  return {
    action: isTool ? "tool" : "agent",
    cronExpression: resolveScheduleCron(draft.schedule),
    name: draft.name.trim(),
    notifyChannel: notifyChannel.length > 0 ? notifyChannel : null,
    prompt: isTool ? "" : draft.agentPrompt.trim(),
    retry: draft.retryOnFailure,
    // An unparseable args textarea degrades to {} — the revision turn just
    // proceeds without the args context rather than blocking the chat.
    toolArguments: parsedArguments?.ok ? parsedArguments.value : {},
    toolName: isTool ? draft.toolName.trim() || null : null,
    toolServer: isTool ? draft.toolServerName.trim() || null : null
  };
}

const PREVIEW_FLOW_ID = "preview";

/** Client-side-only synthetic `FlowProjection` for the "새 흐름 만들기" live
 * preview canvas — never sent anywhere, just re-uses `flowToCanvas`'s real
 * rendering path on a draft that hasn't been created yet. */
export function draftToPreviewProjection(draft: FlowDraft): FlowProjection {
  const triggerId = `${PREVIEW_FLOW_ID}::trigger`;
  const actionId = `${PREVIEW_FLOW_ID}::action`;
  const outputId = `${PREVIEW_FLOW_ID}::output`;
  const cronExpression = draft.schedule.kind === "custom" && !isValidCronShape(draft.schedule.customCron)
    ? ""
    : resolveScheduleCron(draft.schedule);
  const notificationChannelId = draft.notificationChannelId.trim();
  const agentModel = draft.agentModel.trim();
  const actionNode: FlowNode = draft.actionKind === "tool"
    ? {
      id: actionId,
      kind: "action.tool",
      label: "action.tool",
      meta: {
        server: draft.toolServerName.trim().length > 0 ? draft.toolServerName.trim() : null,
        tool: draft.toolName.trim().length > 0 ? draft.toolName.trim() : null
      }
    }
    : {
      id: actionId,
      kind: "action.agent",
      label: "action.agent",
      meta: { maxToolCalls: null, model: agentModel.length > 0 ? agentModel : null, prompt: draft.agentPrompt.trim() }
    };

  const nodes: FlowNode[] = [
    {
      id: triggerId,
      kind: "trigger.schedule",
      label: "trigger.schedule",
      meta: { cronExpression, nextRunAtIso: null, timezone: defaultTimezone() }
    },
    actionNode,
    notificationChannelId.length > 0
      ? { id: outputId, kind: "output.notify", label: "output.notify", meta: { channelId: notificationChannelId } }
      : { id: outputId, kind: "output.record", label: "output.record", meta: {} }
  ];

  const edges: FlowEdge[] = [
    { from: triggerId, id: `${PREVIEW_FLOW_ID}::edge-trigger-action`, to: actionId },
    { from: actionId, id: `${PREVIEW_FLOW_ID}::edge-action-output`, to: outputId }
  ];

  if (draft.retryOnFailure) {
    edges.push({
      from: actionId,
      id: `${PREVIEW_FLOW_ID}::edge-retry`,
      label: `실패 시 재시도 ×${clampRetryCount(draft.maxRetryCount).toString()}`,
      loop: true,
      to: actionId
    });
  }

  return {
    edges,
    enabled: draft.enabled,
    id: PREVIEW_FLOW_ID,
    name: draft.name.trim(),
    nextRunAtIso: null,
    nodes,
    source: "scheduler"
  };
}
