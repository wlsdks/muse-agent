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
}

export interface ActionEditForm {
  readonly agentPrompt: string;
  readonly agentModel: string;
  readonly retryOnFailure: boolean;
  readonly maxRetryCount: number;
}

export interface OutputEditForm {
  readonly notificationChannelId: string;
}

export function triggerFormFromJob(job: Pick<ScheduledJobDetail, "cronExpression">): TriggerEditForm {
  return { schedule: scheduleFormFromCron(job.cronExpression) };
}

export function actionFormFromJob(
  job: Pick<ScheduledJobDetail, "agentPrompt" | "agentModel" | "retryOnFailure" | "maxRetryCount">
): ActionEditForm {
  return {
    agentModel: job.agentModel ?? "",
    agentPrompt: job.agentPrompt ?? "",
    maxRetryCount: job.retryOnFailure ? clampRetryCount(job.maxRetryCount) : DEFAULT_MAX_RETRY_COUNT,
    retryOnFailure: job.retryOnFailure
  };
}

export function outputFormFromJob(job: Pick<ScheduledJobDetail, "notificationChannelId">): OutputEditForm {
  return { notificationChannelId: job.notificationChannelId ?? "" };
}

export function flowEditToJobPatch(kind: "trigger", form: TriggerEditForm): ScheduledJobPatchBody;
export function flowEditToJobPatch(kind: "action", form: ActionEditForm): ScheduledJobPatchBody;
export function flowEditToJobPatch(kind: "output", form: OutputEditForm): ScheduledJobPatchBody;
export function flowEditToJobPatch(
  kind: "trigger" | "action" | "output",
  form: TriggerEditForm | ActionEditForm | OutputEditForm
): ScheduledJobPatchBody {
  if (kind === "trigger") {
    return { cronExpression: resolveScheduleCron((form as TriggerEditForm).schedule) };
  }
  if (kind === "action") {
    const actionForm = form as ActionEditForm;
    return {
      agentModel: actionForm.agentModel.trim().length > 0 ? actionForm.agentModel.trim() : null,
      agentPrompt: actionForm.agentPrompt.trim(),
      maxRetryCount: clampRetryCount(actionForm.maxRetryCount),
      retryOnFailure: actionForm.retryOnFailure
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

export interface FlowDraft {
  readonly name: string;
  readonly schedule: ScheduleFormState;
  readonly agentPrompt: string;
  readonly agentModel: string;
  readonly notificationChannelId: string;
  readonly retryOnFailure: boolean;
  readonly maxRetryCount: number;
  readonly enabled: boolean;
}

export function emptyFlowDraft(): FlowDraft {
  return {
    agentModel: "",
    agentPrompt: "",
    enabled: true,
    maxRetryCount: DEFAULT_MAX_RETRY_COUNT,
    name: "",
    notificationChannelId: "",
    retryOnFailure: false,
    schedule: { customCron: "", kind: "dailyMorning9" }
  };
}

export function isFlowDraftValid(draft: FlowDraft): boolean {
  const scheduleValid = draft.schedule.kind !== "custom" || isValidCronShape(draft.schedule.customCron);
  return draft.name.trim().length > 0 && draft.agentPrompt.trim().length > 0 && scheduleValid;
}

/** Exact `POST /api/scheduler/jobs` body for a new agent flow. */
export function flowDraftToJobInput(draft: FlowDraft, timezone: string = defaultTimezone()): ScheduledJobCreateBody {
  const agentModel = draft.agentModel.trim();
  const notificationChannelId = draft.notificationChannelId.trim();
  return {
    agentModel: agentModel.length > 0 ? agentModel : undefined,
    agentPrompt: draft.agentPrompt.trim(),
    cronExpression: resolveScheduleCron(draft.schedule),
    enabled: draft.enabled,
    jobType: "agent",
    maxRetryCount: clampRetryCount(draft.maxRetryCount),
    name: draft.name.trim(),
    notificationChannelId: notificationChannelId.length > 0 ? notificationChannelId : undefined,
    retryOnFailure: draft.retryOnFailure,
    timezone
  };
}

/** Maps `POST /api/flows/draft`'s response into the SAME `FlowDraft` shape
 * the create form edits — the copilot draft is never auto-created, it just
 * pre-fills this form so the user still reviews + clicks 만들기. A cron the
 * model returned that matches a known preset resolves to that preset
 * (`scheduleFormFromCron`); otherwise it lands in the custom-cron field. */
export function flowDraftFromCopilot(payload: FlowDraftPayloadRow): FlowDraft {
  return {
    agentModel: "",
    agentPrompt: payload.prompt,
    enabled: true,
    maxRetryCount: DEFAULT_MAX_RETRY_COUNT,
    name: payload.name,
    notificationChannelId: payload.notifyChannel ?? "",
    retryOnFailure: payload.retry,
    schedule: scheduleFormFromCron(payload.cronExpression)
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

  const nodes: FlowNode[] = [
    {
      id: triggerId,
      kind: "trigger.schedule",
      label: "trigger.schedule",
      meta: { cronExpression, nextRunAtIso: null, timezone: defaultTimezone() }
    },
    {
      id: actionId,
      kind: "action.agent",
      label: "action.agent",
      meta: { maxToolCalls: null, model: agentModel.length > 0 ? agentModel : null, prompt: draft.agentPrompt.trim() }
    },
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
