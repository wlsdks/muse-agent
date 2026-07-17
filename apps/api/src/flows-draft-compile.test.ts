import { describe, expect, it } from "vitest";

import { buildFlowDraftPrompt, buildFlowDraftRepairPrompt, parseFlowDraftResponse } from "./flows-draft-compile.js";

describe("buildFlowDraftPrompt / buildFlowDraftRepairPrompt", () => {
  it("carries the exact schema + both KO/EN few-shot examples in the system prompt", () => {
    const prompt = buildFlowDraftPrompt("매일 아침 9시에 일정 요약해서 알려줘");
    expect(prompt.system).toContain("cronExpression");
    expect(prompt.system).toContain("notifyChannel");
    expect(prompt.system).toContain("매일 아침 9시에 일정 요약해서 알려줘");
    expect(prompt.system).toContain("every monday at 9am");
    expect(prompt.user).toContain("매일 아침 9시에 일정 요약해서 알려줘");
  });

  it("the repair prompt echoes the prior raw answer + the validation error", () => {
    const prompt = buildFlowDraftRepairPrompt("daily standup at 9am", '{"name":"x"}', "cronExpression must be a 5-field cron expression");
    expect(prompt.user).toContain("cronExpression must be a 5-field cron expression");
    expect(prompt.user).toContain('{"name":"x"}');
    expect(prompt.user).toContain("daily standup at 9am");
  });
});

describe("parseFlowDraftResponse", () => {
  it("parses a clean JSON object", () => {
    const raw = '{"name": "아침 일정 요약", "cronExpression": "0 9 * * *", "prompt": "오늘 일정을 요약해서 알려줘", "notifyChannel": null, "retry": false}';
    const result = parseFlowDraftResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        cronExpression: "0 9 * * *",
        name: "아침 일정 요약",
        notifyChannel: null,
        prompt: "오늘 일정을 요약해서 알려줘",
        retry: false
      });
    }
  });

  it("extracts the JSON object out of surrounding prose", () => {
    const raw = `Sure, here's the draft:\n{"name": "Weekly summary", "cronExpression": "0 9 * * 1", "prompt": "Summarize my week", "notifyChannel": "telegram:555", "retry": true}\nLet me know if you'd like changes.`;
    const result = parseFlowDraftResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cronExpression).toBe("0 9 * * 1");
      expect(result.value.notifyChannel).toBe("telegram:555");
      expect(result.value.retry).toBe(true);
    }
  });

  it("defaults a missing notifyChannel/retry to null/false", () => {
    const raw = '{"name": "Morning brief", "cronExpression": "0 9 * * *", "prompt": "summarize my day"}';
    const result = parseFlowDraftResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.notifyChannel).toBeNull();
      expect(result.value.retry).toBe(false);
    }
  });

  it("rejects a response with no JSON object at all", () => {
    const result = parseFlowDraftResponse("Sorry, I can't help with that.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("JSON object");
    }
  });

  it("rejects a non-5-field cron expression", () => {
    const raw = '{"name": "x", "cronExpression": "9 * * *", "prompt": "y"}';
    const result = parseFlowDraftResponse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cronExpression");
    }
  });

  it("rejects a 5-field-shaped but semantically invalid cron expression", () => {
    const raw = '{"name": "x", "cronExpression": "99 99 99 99 99", "prompt": "y"}';
    const result = parseFlowDraftResponse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cronExpression");
    }
  });

  it("rejects a blank name or prompt", () => {
    const noName = parseFlowDraftResponse('{"name": "  ", "cronExpression": "0 9 * * *", "prompt": "y"}');
    expect(noName.ok).toBe(false);
    const noPrompt = parseFlowDraftResponse('{"name": "x", "cronExpression": "0 9 * * *", "prompt": ""}');
    expect(noPrompt.ok).toBe(false);
  });
});
