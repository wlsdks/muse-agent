import { describe, expect, it } from "vitest";

import { flowToCanvas } from "./flow-canvas-mapping.js";
import {
  actionFormFromJob,
  cronForPreset,
  DEFAULT_MAX_RETRY_COUNT,
  draftToPreviewProjection,
  emptyFlowDraft,
  flowDraftFromCopilot,
  copilotPayloadFromJob,
  flowDraftToCopilotPayload,
  patchFromDraftRevision,
  toolActionFormFromJob,
  flowDraftToJobInput,
  flowEditToJobPatch,
  isFlowDraftValid,
  isValidCronShape,
  MAX_RETRY_COUNT,
  MIN_RETRY_COUNT,
  outputFormFromJob,
  parseToolArgumentsText,
  presetForCron,
  renameFlowPatch,
  resolveScheduleCron,
  SCHEDULE_PRESETS,
  scheduleFormFromCron,
  timezoneOptions,
  toggleEnabledPatch,
  triggerFormFromJob,
  type ActionEditForm,
  type FlowDraft,
  type OutputEditForm,
  type SchedulePresetId,
  type TriggerEditForm
} from "./flow-edit-compile.js";

import type { FlowDraftPayloadRow, ScheduledJobDetail } from "../api/types.js";

const BASE_JOB: ScheduledJobDetail = {
  agentModel: null,
  agentSystemPrompt: null,
  agentPrompt: "오늘 일정 요약해서 보내줘",
  cronExpression: "0 9 * * *",
  enabled: true,
  id: "job_1",
  jobType: "AGENT",
  maxRetryCount: 3,
  name: "Morning brief",
  notificationChannelId: null,
  retryOnFailure: false,
  timezone: "Asia/Seoul"
};

describe("SCHEDULE_PRESETS — the deterministic preset<->cron table", () => {
  it("has exactly the five documented presets with their exact cron strings", () => {
    const byId = Object.fromEntries(SCHEDULE_PRESETS.map((preset) => [preset.id, preset.cronExpression]));
    expect(byId).toEqual({
      dailyEvening6: "0 18 * * *",
      dailyMorning9: "0 9 * * *",
      hourly: "0 * * * *",
      weekdays9: "0 9 * * 1-5",
      weeklyMonday9: "0 9 * * 1"
    });
  });

  it("cronForPreset -> presetForCron round-trips every table entry", () => {
    for (const preset of SCHEDULE_PRESETS) {
      expect(cronForPreset(preset.id)).toBe(preset.cronExpression);
      expect(presetForCron(preset.cronExpression)).toBe(preset.id);
    }
  });

  it("presetForCron falls back to 'custom' for a cron string not in the table", () => {
    expect(presetForCron("*/15 * * * *")).toBe("custom");
    expect(presetForCron("")).toBe("custom");
  });

  it("presetForCron trims surrounding whitespace before matching", () => {
    expect(presetForCron("  0 9 * * *  ")).toBe("dailyMorning9");
  });

  it("cronForPreset throws on an id outside the table (mutation-RED guard: dropping a table entry surfaces here, not a silent undefined cron)", () => {
    expect(() => cronForPreset("nonexistent" as SchedulePresetId)).toThrow(/Unknown schedule preset/);
  });
});

describe("isValidCronShape — 5-field shape check (server remains the real validator)", () => {
  it("accepts every preset's cron string", () => {
    for (const preset of SCHEDULE_PRESETS) {
      expect(isValidCronShape(preset.cronExpression)).toBe(true);
    }
  });

  it("accepts a well-formed custom 5-field expression", () => {
    expect(isValidCronShape("*/15 * * * *")).toBe(true);
    expect(isValidCronShape("30 8 1 * *")).toBe(true);
  });

  it("rejects too few or too many fields", () => {
    expect(isValidCronShape("0 9 * *")).toBe(false);
    expect(isValidCronShape("0 9 * * * * *")).toBe(false);
    expect(isValidCronShape("")).toBe(false);
  });

  it("rejects a 6-field (seconds-first) expression — the client shape check is deliberately 5-field only; the server (cron-parser) is more lenient and is the final validator on save", () => {
    expect(isValidCronShape("0 0 9 * * *")).toBe(false);
  });
});

describe("ScheduleFormState round-trip", () => {
  it("a preset cron resolves to that preset's kind and back to the same cron", () => {
    for (const preset of SCHEDULE_PRESETS) {
      const form = scheduleFormFromCron(preset.cronExpression);
      expect(form.kind).toBe(preset.id);
      expect(resolveScheduleCron(form)).toBe(preset.cronExpression);
    }
  });

  it("a non-preset cron round-trips through 'custom'", () => {
    const form = scheduleFormFromCron("*/5 * * * *");
    expect(form).toEqual({ customCron: "*/5 * * * *", kind: "custom" });
    expect(resolveScheduleCron(form)).toBe("*/5 * * * *");
  });
});

describe("triggerFormFromJob / actionFormFromJob / outputFormFromJob — job -> edit form initial values", () => {
  it("trigger form derives the preset (or custom) from the job's cron and carries the job's timezone", () => {
    expect(triggerFormFromJob(BASE_JOB)).toEqual({
      schedule: { customCron: "", kind: "dailyMorning9" },
      timezone: "Asia/Seoul"
    });
    expect(triggerFormFromJob({ cronExpression: "*/10 * * * *", timezone: "UTC" })).toEqual({
      schedule: { customCron: "*/10 * * * *", kind: "custom" },
      timezone: "UTC"
    });
  });

  it("action form carries prompt/model through, retryOnFailure false -> a default retry count (unused until toggled on)", () => {
    expect(actionFormFromJob(BASE_JOB)).toEqual({
      agentModel: "",
      agentSystemPrompt: "",
      agentPrompt: "오늘 일정 요약해서 보내줘",
      maxRetryCount: DEFAULT_MAX_RETRY_COUNT,
      retryOnFailure: false
    });
  });

  it("action form carries a real maxRetryCount through when retryOnFailure is true", () => {
    const job: ScheduledJobDetail = { ...BASE_JOB, agentModel: "gpt-4o", maxRetryCount: 5, retryOnFailure: true };
    expect(actionFormFromJob(job)).toEqual({
      agentModel: "gpt-4o",
      agentSystemPrompt: "",
      agentPrompt: "오늘 일정 요약해서 보내줘",
      maxRetryCount: 5,
      retryOnFailure: true
    });
  });

  it("action form clamps an out-of-range persisted maxRetryCount into the UI's 1-5 band", () => {
    const job: ScheduledJobDetail = { ...BASE_JOB, maxRetryCount: 40, retryOnFailure: true };
    expect(actionFormFromJob(job).maxRetryCount).toBe(MAX_RETRY_COUNT);
  });

  it("output form is empty when no notify channel is set, and carries the channel id when it is", () => {
    expect(outputFormFromJob(BASE_JOB)).toEqual({ notificationChannelId: "" });
    expect(outputFormFromJob({ ...BASE_JOB, notificationChannelId: "telegram:123" })).toEqual({
      notificationChannelId: "telegram:123"
    });
  });
});

describe("timezoneOptions — the trigger timezone picker's option list", () => {
  it("includes the job's current timezone even when it is not in the curated set (never silently drops it)", () => {
    const options = timezoneOptions("Pacific/Chatham");
    expect(options).toContain("Pacific/Chatham");
    expect(options).toContain("UTC");
    expect(options).toContain("Asia/Seoul");
  });

  it("does not duplicate a current timezone that is already curated", () => {
    const options = timezoneOptions("Asia/Seoul");
    expect(options.filter((tz) => tz === "Asia/Seoul")).toHaveLength(1);
  });
});

describe("flowEditToJobPatch — exact PATCH body per node kind (field-name fidelity against the server contract)", () => {
  it("trigger edit patches the resolved cron AND the chosen timezone", () => {
    const form: TriggerEditForm = { schedule: { customCron: "", kind: "hourly" }, timezone: "Asia/Seoul" };
    expect(flowEditToJobPatch("trigger", form)).toEqual({ cronExpression: "0 * * * *", timezone: "Asia/Seoul" });
  });

  it("trigger edit resolves a custom cron verbatim and carries the timezone", () => {
    const form: TriggerEditForm = { schedule: { customCron: "15 3 * * 2", kind: "custom" }, timezone: "UTC" };
    expect(flowEditToJobPatch("trigger", form)).toEqual({ cronExpression: "15 3 * * 2", timezone: "UTC" });
  });

  it("action edit with retry OFF sends retryOnFailure: false and a clamped maxRetryCount", () => {
    const form: ActionEditForm = { agentModel: "", agentSystemPrompt: "", agentPrompt: "  do the thing  ", maxRetryCount: 3, retryOnFailure: false };
    expect(flowEditToJobPatch("action", form)).toEqual({
      agentModel: null,
      agentSystemPrompt: null,
      agentPrompt: "do the thing",
      maxRetryCount: 3,
      retryOnFailure: false
    });
  });

  it("action edit with retry ON sends retryOnFailure: true and the chosen count — the two directions of the retry mutation-RED case", () => {
    const form: ActionEditForm = { agentModel: "gemma4", agentSystemPrompt: "", agentPrompt: "run it", maxRetryCount: 5, retryOnFailure: true };
    expect(flowEditToJobPatch("action", form)).toEqual({
      agentModel: "gemma4",
      agentSystemPrompt: null,
      agentPrompt: "run it",
      maxRetryCount: 5,
      retryOnFailure: true
    });
  });

  it("action edit sends the trimmed agentSystemPrompt when set, null when blank", () => {
    const withSystem: ActionEditForm = { agentModel: "", agentSystemPrompt: "  Answer in Korean.  ", agentPrompt: "hi", maxRetryCount: 3, retryOnFailure: false };
    expect(flowEditToJobPatch("action", withSystem).agentSystemPrompt).toBe("Answer in Korean.");
    const blank: ActionEditForm = { agentModel: "", agentSystemPrompt: "   ", agentPrompt: "hi", maxRetryCount: 3, retryOnFailure: false };
    expect(flowEditToJobPatch("action", blank).agentSystemPrompt).toBeNull();
  });

  it("action edit clamps an out-of-band maxRetryCount into 1-5 before sending", () => {
    const tooHigh: ActionEditForm = { agentModel: "", agentSystemPrompt: "", agentPrompt: "x", maxRetryCount: 99, retryOnFailure: true };
    const tooLow: ActionEditForm = { agentModel: "", agentSystemPrompt: "", agentPrompt: "x", maxRetryCount: -1, retryOnFailure: true };
    expect(flowEditToJobPatch("action", tooHigh).maxRetryCount).toBe(MAX_RETRY_COUNT);
    expect(flowEditToJobPatch("action", tooLow).maxRetryCount).toBe(MIN_RETRY_COUNT);
  });

  it("output edit sends the trimmed channel id when set", () => {
    const form: OutputEditForm = { notificationChannelId: "  telegram:456  " };
    expect(flowEditToJobPatch("output", form)).toEqual({ notificationChannelId: "telegram:456" });
  });

  it("output edit sends null to CLEAR the channel (empty input) — never omits the key or sends an empty string", () => {
    const form: OutputEditForm = { notificationChannelId: "   " };
    expect(flowEditToJobPatch("output", form)).toEqual({ notificationChannelId: null });
  });

  it("renameFlowPatch / toggleEnabledPatch send exactly one field each", () => {
    expect(renameFlowPatch("  New name  ")).toEqual({ name: "New name" });
    expect(toggleEnabledPatch(false)).toEqual({ enabled: false });
    expect(toggleEnabledPatch(true)).toEqual({ enabled: true });
  });
});

describe("flowDraftToJobInput — exact POST /api/scheduler/jobs body", () => {
  const FULL_DRAFT: FlowDraft = {
    actionKind: "agent",
    agentModel: "gpt-4o",
    agentSystemPrompt: "",
    agentPrompt: "오늘 일정 요약해서 보내줘",
    enabled: true,
    maxRetryCount: 4,
    name: "Morning brief",
    notificationChannelId: "telegram:123",
    retryOnFailure: true,
    schedule: { customCron: "", kind: "dailyMorning9" },
    toolArgumentsText: "",
    toolName: "",
    toolServerName: ""
  };

  it("compiles every field with the server's exact field names, including the mandatory jobType: 'agent'", () => {
    expect(flowDraftToJobInput(FULL_DRAFT, "Asia/Seoul")).toEqual({
      agentModel: "gpt-4o",
      agentPrompt: "오늘 일정 요약해서 보내줘",
      cronExpression: "0 9 * * *",
      enabled: true,
      jobType: "agent",
      maxRetryCount: 4,
      name: "Morning brief",
      notificationChannelId: "telegram:123",
      retryOnFailure: true,
      timezone: "Asia/Seoul"
    });
  });

  it("omits agentModel and notificationChannelId entirely (undefined, not empty string) when left blank — undefined values drop out of the JSON.stringify'd wire body, unlike an empty string", () => {
    const draft: FlowDraft = { ...FULL_DRAFT, agentModel: "  ", notificationChannelId: "" };
    const body = flowDraftToJobInput(draft, "UTC");
    expect(body.jobType).toBe("agent");
    expect(body.jobType === "agent" ? body.agentModel : undefined).toBeUndefined();
    expect(body.notificationChannelId).toBeUndefined();
    const wireKeys = Object.keys(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
    expect(wireKeys).not.toContain("agentModel");
    expect(wireKeys).not.toContain("notificationChannelId");
  });

  it("defaults the timezone to the runtime's resolved IANA zone when not supplied", () => {
    const body = flowDraftToJobInput(FULL_DRAFT);
    expect(body.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("resolves a custom raw cron verbatim into cronExpression", () => {
    const draft: FlowDraft = { ...FULL_DRAFT, schedule: { customCron: "0 7 * * 6,0", kind: "custom" } };
    expect(flowDraftToJobInput(draft, "UTC").cronExpression).toBe("0 7 * * 6,0");
  });

  it("carries retryOnFailure: false through untouched when the draft has retry off", () => {
    const draft: FlowDraft = { ...FULL_DRAFT, retryOnFailure: false };
    expect(flowDraftToJobInput(draft, "UTC").retryOnFailure).toBe(false);
  });
});

describe("flowDraftToJobInput — tool-flow (jobType: 'mcp_tool') compile seam", () => {
  const TOOL_DRAFT: FlowDraft = {
    actionKind: "tool",
    agentModel: "",
    agentSystemPrompt: "",
    agentPrompt: "",
    enabled: true,
    maxRetryCount: 3,
    name: "Time check",
    notificationChannelId: "",
    retryOnFailure: false,
    schedule: { customCron: "", kind: "hourly" },
    toolArgumentsText: '{"timezone":"Asia/Seoul"}',
    toolName: "now",
    toolServerName: "muse.time"
  };

  it("compiles jobType: 'mcp_tool' with mcpServerName/toolName/toolArguments — NO agentPrompt key on the wire", () => {
    const body = flowDraftToJobInput(TOOL_DRAFT, "UTC");
    expect(body).toEqual({
      cronExpression: "0 * * * *",
      enabled: true,
      jobType: "mcp_tool",
      maxRetryCount: 3,
      mcpServerName: "muse.time",
      name: "Time check",
      retryOnFailure: false,
      timezone: "UTC",
      toolArguments: { timezone: "Asia/Seoul" },
      toolName: "now"
    } as unknown as ReturnType<typeof flowDraftToJobInput>);
    const wireKeys = Object.keys(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
    expect(wireKeys).not.toContain("agentPrompt");
    expect(wireKeys).not.toContain("agentModel");
  });

  it("MUTATION-RED: dropping jobType from the compiled body would silently create an agent job instead of a tool job — this is the field the server discriminates on", () => {
    const body = flowDraftToJobInput(TOOL_DRAFT, "UTC");
    expect(body.jobType).toBe("mcp_tool");
  });

  it("blank tool-arguments text compiles to an empty object, never omitted", () => {
    const draft: FlowDraft = { ...TOOL_DRAFT, toolArgumentsText: "" };
    const body = flowDraftToJobInput(draft, "UTC");
    expect(body.jobType === "mcp_tool" ? body.toolArguments : undefined).toEqual({});
  });

  it("invalid JSON in the arguments textarea compiles to an empty object rather than throwing — the form gates Create on isFlowDraftValid, this is the defensive fallback", () => {
    const draft: FlowDraft = { ...TOOL_DRAFT, toolArgumentsText: "not json" };
    const body = flowDraftToJobInput(draft, "UTC");
    expect(body.jobType === "mcp_tool" ? body.toolArguments : undefined).toEqual({});
  });
});

describe("parseToolArgumentsText", () => {
  it("blank text parses to an empty object", () => {
    expect(parseToolArgumentsText("")).toEqual({ ok: true, value: {} });
    expect(parseToolArgumentsText("   ")).toEqual({ ok: true, value: {} });
  });

  it("a well-formed JSON object parses through", () => {
    expect(parseToolArgumentsText('{"a": 1, "b": "two"}')).toEqual({ ok: true, value: { a: 1, b: "two" } });
  });

  it("rejects malformed JSON", () => {
    expect(parseToolArgumentsText("{not json")).toEqual({ ok: false });
  });

  it("MUTATION-RED: rejects a JSON array and a JSON primitive — must be an OBJECT, not just 'valid JSON'", () => {
    expect(parseToolArgumentsText("[1,2,3]")).toEqual({ ok: false });
    expect(parseToolArgumentsText("42")).toEqual({ ok: false });
    expect(parseToolArgumentsText('"a string"')).toEqual({ ok: false });
    expect(parseToolArgumentsText("null")).toEqual({ ok: false });
  });
});

describe("isFlowDraftValid", () => {
  it("an empty draft is invalid (no name, no prompt)", () => {
    expect(isFlowDraftValid(emptyFlowDraft())).toBe(false);
  });

  it("requires a non-blank name and a non-blank prompt", () => {
    const base = { ...emptyFlowDraft(), agentPrompt: "do it", name: "My flow" };
    expect(isFlowDraftValid(base)).toBe(true);
    expect(isFlowDraftValid({ ...base, name: "   " })).toBe(false);
    expect(isFlowDraftValid({ ...base, agentPrompt: "" })).toBe(false);
  });

  it("a custom schedule must pass the cron shape check to be valid", () => {
    const base = { ...emptyFlowDraft(), agentPrompt: "do it", name: "My flow" };
    expect(isFlowDraftValid({ ...base, schedule: { customCron: "not a cron", kind: "custom" } })).toBe(false);
    expect(isFlowDraftValid({ ...base, schedule: { customCron: "0 9 * * *", kind: "custom" } })).toBe(true);
  });

  it("actionKind 'tool' requires a non-blank server AND tool name, ignoring agentPrompt", () => {
    const base = { ...emptyFlowDraft(), actionKind: "tool" as const, name: "My tool flow" };
    expect(isFlowDraftValid(base)).toBe(false);
    expect(isFlowDraftValid({ ...base, toolServerName: "muse.time" })).toBe(false);
    expect(isFlowDraftValid({ ...base, toolName: "now" })).toBe(false);
    expect(isFlowDraftValid({ ...base, toolName: "now", toolServerName: "muse.time" })).toBe(true);
  });

  it("actionKind 'tool' with invalid JSON in the arguments textarea is invalid", () => {
    const base = { ...emptyFlowDraft(), actionKind: "tool" as const, name: "My tool flow", toolName: "now", toolServerName: "muse.time" };
    expect(isFlowDraftValid({ ...base, toolArgumentsText: "not json" })).toBe(false);
    expect(isFlowDraftValid({ ...base, toolArgumentsText: '{"a":1}' })).toBe(true);
    expect(isFlowDraftValid({ ...base, toolArgumentsText: "" })).toBe(true);
  });
});

describe("draftToPreviewProjection — client-side-only preview, never sent to the server", () => {
  const DRAFT: FlowDraft = {
    actionKind: "agent",
    agentModel: "",
    agentSystemPrompt: "",
    agentPrompt: "매일 아침 브리핑",
    enabled: true,
    maxRetryCount: 3,
    name: "New flow",
    notificationChannelId: "",
    retryOnFailure: false,
    schedule: { customCron: "", kind: "dailyMorning9" },
    toolArgumentsText: "",
    toolName: "",
    toolServerName: ""
  };

  it("produces a trigger -> action -> output linear projection with the resolved cron", () => {
    const projection = draftToPreviewProjection(DRAFT);
    expect(projection.nodes).toHaveLength(3);
    expect(projection.nodes[0]).toMatchObject({ kind: "trigger.schedule", meta: { cronExpression: "0 9 * * *" } });
    expect(projection.nodes[1]).toMatchObject({ kind: "action.agent", meta: { prompt: "매일 아침 브리핑" } });
    expect(projection.nodes[2]).toMatchObject({ kind: "output.record" });
    expect(projection.edges).toHaveLength(2);
  });

  it("projects output.notify when a notify channel is set on the draft", () => {
    const projection = draftToPreviewProjection({ ...DRAFT, notificationChannelId: "telegram:1" });
    expect(projection.nodes[2]).toMatchObject({ kind: "output.notify", meta: { channelId: "telegram:1" } });
  });

  it("adds the retry self-edge only when the draft's retryOnFailure is true", () => {
    const withoutRetry = draftToPreviewProjection(DRAFT);
    expect(withoutRetry.edges.some((edge) => edge.loop)).toBe(false);

    const withRetry = draftToPreviewProjection({ ...DRAFT, maxRetryCount: 5, retryOnFailure: true });
    const loopEdge = withRetry.edges.find((edge) => edge.loop);
    expect(loopEdge).toBeDefined();
    expect(loopEdge!.label).toContain("5");
  });

  it("an unresolvable custom cron previews an empty cronExpression rather than throwing", () => {
    const projection = draftToPreviewProjection({ ...DRAFT, schedule: { customCron: "garbage", kind: "custom" } });
    expect(projection.nodes[0]!.meta.cronExpression).toBe("");
  });

  it("is renderable through the real flowToCanvas mapper (same shape a real projection would produce)", () => {
    const projection = draftToPreviewProjection({ ...DRAFT, retryOnFailure: true, maxRetryCount: 2 });
    const canvas = flowToCanvas(projection);
    expect(canvas.nodes).toHaveLength(3);
    expect(canvas.edges.some((edge) => edge.data?.loop)).toBe(true);
  });

  it("projects an action.tool node (never action.agent) when actionKind is 'tool'", () => {
    const toolDraft: FlowDraft = { ...DRAFT, actionKind: "tool", toolName: "now", toolServerName: "muse.time" };
    const projection = draftToPreviewProjection(toolDraft);
    expect(projection.nodes[1]).toMatchObject({ kind: "action.tool", meta: { server: "muse.time", tool: "now" } });
  });

  it("previews null server/tool meta before either is chosen yet, rather than empty strings", () => {
    const toolDraft: FlowDraft = { ...DRAFT, actionKind: "tool" };
    const projection = draftToPreviewProjection(toolDraft);
    expect(projection.nodes[1]).toMatchObject({ kind: "action.tool", meta: { server: null, tool: null } });
  });
});

describe("flowDraftToCopilotPayload — the create panel's LIVE form values, projected into the copilot's 5-field shape", () => {
  it("round-trips through flowDraftFromCopilot for a full draft (custom cron, notify, retry)", () => {
    const payload: FlowDraftPayloadRow = {
      action: "agent",
      cronExpression: "15 7 * * 2",
      name: "화요일 리마인더",
      notifyChannel: "telegram:999",
      prompt: "이번 주 할 일 알려줘",
      retry: true,
      toolArguments: {},
      toolName: null,
      toolServer: null
    };
    const draft = flowDraftFromCopilot(payload);
    expect(flowDraftToCopilotPayload(draft)).toEqual(payload);
  });

  it("round-trips a TOOL draft (action/toolServer/toolName preserved, prompt blank)", () => {
    const payload: FlowDraftPayloadRow = {
      action: "tool",
      cronExpression: "0 * * * *",
      name: "매시간 시각 기록",
      notifyChannel: null,
      prompt: "",
      retry: false,
      toolArguments: {},
      toolName: "now",
      toolServer: "muse.time"
    };
    const draft = flowDraftFromCopilot(payload);
    expect(draft.actionKind).toBe("tool");
    expect(draft.toolServerName).toBe("muse.time");
    expect(draft.toolName).toBe("now");
    expect(flowDraftToCopilotPayload(draft)).toEqual(payload);
  });

  it("resolves a preset schedule back to its raw cron expression", () => {
    const draft: FlowDraft = {
      actionKind: "agent",
      agentModel: "",
      agentSystemPrompt: "",
      agentPrompt: "일정 요약",
      enabled: true,
      maxRetryCount: DEFAULT_MAX_RETRY_COUNT,
      name: "아침 브리핑",
      notificationChannelId: "",
      retryOnFailure: false,
      schedule: { customCron: "", kind: "dailyMorning9" },
      toolArgumentsText: "",
      toolName: "",
      toolServerName: ""
    };
    expect(flowDraftToCopilotPayload(draft)).toEqual({
      action: "agent",
      cronExpression: "0 9 * * *",
      name: "아침 브리핑",
      notifyChannel: null,
      prompt: "일정 요약",
      retry: false,
      toolArguments: {},
      toolName: null,
      toolServer: null
    });
  });

  it("normalizes a blank notify channel to null and trims whitespace off name/prompt", () => {
    const draft: FlowDraft = {
      actionKind: "agent",
      agentModel: "",
      agentSystemPrompt: "",
      agentPrompt: "  일정 요약  ",
      enabled: true,
      maxRetryCount: DEFAULT_MAX_RETRY_COUNT,
      name: "  아침 브리핑  ",
      notificationChannelId: "   ",
      retryOnFailure: false,
      schedule: { customCron: "", kind: "hourly" },
      toolArgumentsText: "",
      toolName: "",
      toolServerName: ""
    };
    const payload = flowDraftToCopilotPayload(draft);
    expect(payload.name).toBe("아침 브리핑");
    expect(payload.prompt).toBe("일정 요약");
    expect(payload.notifyChannel).toBeNull();
  });
});

describe("copilot tool-arguments prefill", () => {
  it("a drafted tool flow's toolArguments prefill the args textarea as pretty JSON", () => {
    const payload: FlowDraftPayloadRow = {
      action: "tool",
      cronExpression: "0 * * * *",
      name: "매시간 URL 파싱",
      notifyChannel: null,
      prompt: "",
      retry: false,
      toolArguments: { url: "https://news.ycombinator.com" },
      toolName: "parse",
      toolServer: "muse.url"
    };
    const draft = flowDraftFromCopilot(payload);
    expect(JSON.parse(draft.toolArgumentsText)).toEqual({ url: "https://news.ycombinator.com" });
    expect(flowDraftToCopilotPayload(draft)).toEqual(payload);
  });

  it("an agent draft leaves the args textarea blank and projects toolArguments {}", () => {
    const payload: FlowDraftPayloadRow = {
      action: "agent",
      cronExpression: "0 9 * * *",
      name: "브리핑",
      notifyChannel: null,
      prompt: "요약해줘",
      retry: false,
      toolArguments: {},
      toolName: null,
      toolServer: null
    };
    const draft = flowDraftFromCopilot(payload);
    expect(draft.toolArgumentsText).toBe("");
    expect(flowDraftToCopilotPayload(draft).toolArguments).toEqual({});
  });

  it("an unparseable args textarea degrades to {} in the revision payload", () => {
    const payload: FlowDraftPayloadRow = {
      action: "tool",
      cronExpression: "0 * * * *",
      name: "매시간 시각 기록",
      notifyChannel: null,
      prompt: "",
      retry: false,
      toolArguments: {},
      toolName: "now",
      toolServer: "muse.time"
    };
    const draft = { ...flowDraftFromCopilot(payload), toolArgumentsText: "{not json" };
    expect(flowDraftToCopilotPayload(draft).toolArguments).toEqual({});
  });
});

describe("flowEditToJobPatch — tool node with an editable tool pair", () => {
  it("PATCHes mcpServerName + toolName + parsed toolArguments together", () => {
    const patch = flowEditToJobPatch("tool", {
      toolArgumentsText: '{"url": "https://a.com"}',
      toolName: "parse",
      toolServerName: "muse.url"
    });
    expect(patch).toEqual({
      mcpServerName: "muse.url",
      toolArguments: { url: "https://a.com" },
      toolName: "parse"
    });
  });

  it("trims the pair and degrades unparseable args to {}", () => {
    const patch = flowEditToJobPatch("tool", {
      toolArgumentsText: "{not json",
      toolName: "  now  ",
      toolServerName: "  muse.time  "
    });
    expect(patch).toEqual({ mcpServerName: "muse.time", toolArguments: {}, toolName: "now" });
  });

  it("toolActionFormFromJob seeds the pair from the job detail", () => {
    const form = toolActionFormFromJob({ mcpServerName: "muse.url", toolArguments: { url: "x" }, toolName: "parse" });
    expect(form.toolServerName).toBe("muse.url");
    expect(form.toolName).toBe("parse");
    expect(JSON.parse(form.toolArgumentsText)).toEqual({ url: "x" });
  });
});

describe("flowDraftFromCopilot — revision base preservation", () => {
  it("keeps model/system-prompt/retry-count/enabled from the live form the payload cannot express", () => {
    const base = {
      ...flowDraftFromCopilot({
        action: "agent" as const,
        cronExpression: "0 9 * * *",
        name: "브리핑",
        notifyChannel: null,
        prompt: "요약해줘",
        retry: false,
        toolArguments: {},
        toolName: null,
        toolServer: null
      }),
      agentModel: "ollama/qwen3:8b",
      agentSystemPrompt: "간결하게",
      enabled: false,
      maxRetryCount: 5
    };
    const revised = flowDraftFromCopilot(
      {
        action: "agent",
        cronExpression: "30 8 * * *",
        name: "브리핑",
        notifyChannel: null,
        prompt: "요약해줘",
        retry: false,
        toolArguments: {},
        toolName: null,
        toolServer: null
      },
      base
    );
    expect(revised.agentModel).toBe("ollama/qwen3:8b");
    expect(revised.agentSystemPrompt).toBe("간결하게");
    expect(revised.maxRetryCount).toBe(5);
    expect(revised.enabled).toBe(false);
    expect(revised.schedule).toEqual({ customCron: "30 8 * * *", kind: "custom" });
  });

  it("without a base (first turn) the defaults stay", () => {
    const draft = flowDraftFromCopilot({
      action: "agent",
      cronExpression: "0 9 * * *",
      name: "브리핑",
      notifyChannel: null,
      prompt: "요약해줘",
      retry: false,
      toolArguments: {},
      toolName: null,
      toolServer: null
    });
    expect(draft.agentModel).toBe("");
    expect(draft.agentSystemPrompt).toBe("");
    expect(draft.enabled).toBe(true);
  });
});

describe("copilotPayloadFromJob / patchFromDraftRevision — editing an EXISTING flow through the copilot", () => {
  const AGENT_JOB = {
    agentModel: null,
    agentPrompt: "오늘 일정 요약해줘",
    agentSystemPrompt: null,
    cronExpression: "0 9 * * *",
    enabled: true,
    id: "job_1",
    jobType: "AGENT",
    maxRetryCount: 3,
    name: "아침 브리핑",
    notificationChannelId: null,
    retryOnFailure: false,
    timezone: "UTC"
  } as never;
  const TOOL_JOB = {
    agentModel: null,
    agentPrompt: "",
    agentSystemPrompt: null,
    cronExpression: "0 * * * *",
    enabled: true,
    id: "job_2",
    jobType: "MCP_TOOL",
    maxRetryCount: 3,
    mcpServerName: "muse.url",
    name: "URL 파싱",
    notificationChannelId: "telegram:1",
    retryOnFailure: true,
    timezone: "UTC",
    toolArguments: { url: "https://a.com" },
    toolName: "parse"
  } as never;

  it("projects an agent job into the copilot payload shape", () => {
    expect(copilotPayloadFromJob(AGENT_JOB)).toEqual({
      action: "agent",
      cronExpression: "0 9 * * *",
      name: "아침 브리핑",
      notifyChannel: null,
      prompt: "오늘 일정 요약해줘",
      retry: false,
      toolArguments: {},
      toolName: null,
      toolServer: null
    });
  });

  it("projects a tool job (pair + args + notify + retry)", () => {
    expect(copilotPayloadFromJob(TOOL_JOB)).toEqual({
      action: "tool",
      cronExpression: "0 * * * *",
      name: "URL 파싱",
      notifyChannel: "telegram:1",
      prompt: "",
      retry: true,
      toolArguments: { url: "https://a.com" },
      toolName: "parse",
      toolServer: "muse.url"
    });
  });

  it("maps changed fields to the exact PATCH body (agent: cron + notify)", () => {
    const previous = copilotPayloadFromJob(AGENT_JOB);
    const next = { ...previous, cronExpression: "30 8 * * *", notifyChannel: "telegram:9" };
    const result = patchFromDraftRevision(previous, next);
    expect(result).toEqual({ ok: true, patch: { cronExpression: "30 8 * * *", notificationChannelId: "telegram:9" } });
  });

  it("maps a tool-pair + args change to mcpServerName/toolName/toolArguments together", () => {
    const previous = copilotPayloadFromJob(TOOL_JOB);
    const next = { ...previous, toolArguments: { from: "a", to: "b" }, toolName: "diff_ms", toolServer: "muse.time" };
    const result = patchFromDraftRevision(previous, next);
    expect(result).toEqual({
      ok: true,
      patch: { mcpServerName: "muse.time", toolArguments: { from: "a", to: "b" }, toolName: "diff_ms" }
    });
  });

  it("a changed tool pair WITHOUT changed args still re-sends the args (one PATCH unit)", () => {
    const previous = copilotPayloadFromJob(TOOL_JOB);
    const next = { ...previous, toolName: "encode_query" };
    const result = patchFromDraftRevision(previous, next);
    expect(result).toEqual({
      ok: true,
      patch: { mcpServerName: "muse.url", toolArguments: { url: "https://a.com" }, toolName: "encode_query" }
    });
  });

  it("no change → { ok: false, reason: 'no-change' }", () => {
    const previous = copilotPayloadFromJob(AGENT_JOB);
    expect(patchFromDraftRevision(previous, { ...previous })).toEqual({ ok: false, reason: "no-change" });
  });

  it("an agent↔tool action flip is refused deterministically", () => {
    const previous = copilotPayloadFromJob(AGENT_JOB);
    const next = { ...previous, action: "tool" as const, prompt: "", toolArguments: {}, toolName: "now", toolServer: "muse.time" };
    expect(patchFromDraftRevision(previous, next)).toEqual({ ok: false, reason: "action-flip" });
  });

  it("a name + prompt + retry change maps to name/agentPrompt/retryOnFailure", () => {
    const previous = copilotPayloadFromJob(AGENT_JOB);
    const next = { ...previous, name: "저녁 브리핑", prompt: "저녁 요약해줘", retry: true };
    expect(patchFromDraftRevision(previous, next)).toEqual({
      ok: true,
      patch: { agentPrompt: "저녁 요약해줘", name: "저녁 브리핑", retryOnFailure: true }
    });
  });
});
