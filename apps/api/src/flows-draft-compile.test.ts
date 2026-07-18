import { describe, expect, it } from "vitest";

import {
  buildFlowDraftPrompt,
  buildFlowDraftRepairPrompt,
  buildFlowDraftRevisionPrompt,
  buildFlowDraftRevisionRepairPrompt,
  parseCurrentDraftInput,
  parseFlowDraftResponse
} from "./flows-draft-compile.js";

import type { FlowDraftPayload } from "./flows-draft-compile.js";

const SAMPLE_DRAFT: FlowDraftPayload = {
  action: "agent",
  cronExpression: "0 9 * * *",
  name: "아침 브리핑",
  notifyChannel: null,
  prompt: "오늘 일정을 요약해서 알려줘",
  retry: false,
  toolArguments: {},
  toolName: null,
  toolServer: null
};

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
        action: "agent",
        cronExpression: "0 9 * * *",
        name: "아침 일정 요약",
        notifyChannel: null,
        prompt: "오늘 일정을 요약해서 알려줘",
        retry: false,
        toolArguments: {},
        toolName: null,
        toolServer: null
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

  it("with requireAllFields, accepts a response that literally carries a null notifyChannel", () => {
    const raw = '{"name": "x", "cronExpression": "0 9 * * *", "prompt": "y", "notifyChannel": null, "retry": false, "action": "agent"}';
    const result = parseFlowDraftResponse(raw, { requireAllFields: true });
    expect(result.ok).toBe(true);
  });

  it("with requireAllFields, rejects a revision response that DROPS action (a tool draft must never silently flip to agent)", () => {
    const raw = '{"name": "x", "cronExpression": "0 9 * * *", "prompt": "y", "notifyChannel": null, "retry": false}';
    const result = parseFlowDraftResponse(raw, { requireAllFields: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("action");
    }
  });

  it("with requireAllFields, rejects a response that DROPS notifyChannel entirely (never silently defaults it)", () => {
    const raw = '{"name": "x", "cronExpression": "0 9 * * *", "prompt": "y", "retry": false}';
    const result = parseFlowDraftResponse(raw, { requireAllFields: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("notifyChannel");
    }
  });

  it("with requireAllFields, rejects a response that DROPS retry entirely", () => {
    const raw = '{"name": "x", "cronExpression": "0 9 * * *", "prompt": "y", "notifyChannel": null}';
    const result = parseFlowDraftResponse(raw, { requireAllFields: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("retry");
    }
  });

  it("without requireAllFields (the first-draft path), a missing notifyChannel/retry still defaults, unchanged behavior", () => {
    const raw = '{"name": "x", "cronExpression": "0 9 * * *", "prompt": "y"}';
    const result = parseFlowDraftResponse(raw);
    expect(result.ok).toBe(true);
  });
});

describe("buildFlowDraftRevisionPrompt / buildFlowDraftRevisionRepairPrompt", () => {
  it("carries the current draft JSON, the schema, and both KO/EN revision few-shots", () => {
    const prompt = buildFlowDraftRevisionPrompt("8시 반으로 바꿔줘", SAMPLE_DRAFT);
    expect(prompt.system).toContain("FULL updated JSON");
    expect(prompt.system).toContain("notifyChannel");
    expect(prompt.system).toContain("30 8 * * *");
    expect(prompt.system).toContain("telegram:123");
    expect(prompt.user).toContain(JSON.stringify(SAMPLE_DRAFT));
    expect(prompt.user).toContain("8시 반으로 바꿔줘");
  });

  it("the revision repair prompt echoes the current draft again + the prior raw answer + the validation error", () => {
    const prompt = buildFlowDraftRevisionRepairPrompt(
      "텔레그램 123으로도 보내줘",
      SAMPLE_DRAFT,
      '{"name":"아침 브리핑"}',
      "revision response is missing required field 'retry'"
    );
    expect(prompt.user).toContain(JSON.stringify(SAMPLE_DRAFT));
    expect(prompt.user).toContain("텔레그램 123으로도 보내줘");
    expect(prompt.user).toContain("revision response is missing required field 'retry'");
    expect(prompt.user).toContain('{"name":"아침 브리핑"}');
  });
});

describe("parseFlowDraftResponse — tool drafts", () => {
  const TOOLS = [
    { description: "Current time", server: "muse.time", tool: "now" },
    { description: "Text stats", server: "muse.text", tool: "stats" }
  ];

  it("parses a tool draft whose pair is in the allowed list (prompt normalized to blank)", () => {
    const raw = '{"name": "매시간 시각", "cronExpression": "0 * * * *", "prompt": "whatever", "notifyChannel": null, "retry": false, "action": "tool", "toolServer": "muse.time", "toolName": "now"}';
    const result = parseFlowDraftResponse(raw, { allowedTools: TOOLS });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action).toBe("tool");
      expect(result.value.toolServer).toBe("muse.time");
      expect(result.value.toolName).toBe("now");
      expect(result.value.prompt).toBe("");
    }
  });

  it("rejects a tool draft whose pair is NOT in the allowed list (never a stored-but-unrunnable job)", () => {
    const raw = '{"name": "x", "cronExpression": "0 * * * *", "prompt": "", "notifyChannel": null, "retry": false, "action": "tool", "toolServer": "muse.messaging", "toolName": "send"}';
    const result = parseFlowDraftResponse(raw, { allowedTools: TOOLS });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("muse.messaging.send");
    }
  });

  it("rejects action tool without a tool pair", () => {
    const raw = '{"name": "x", "cronExpression": "0 * * * *", "prompt": "y", "action": "tool"}';
    const result = parseFlowDraftResponse(raw, { allowedTools: TOOLS });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown action value", () => {
    const raw = '{"name": "x", "cronExpression": "0 * * * *", "prompt": "y", "action": "banana"}';
    const result = parseFlowDraftResponse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("action");
    }
  });

  it("normalizes a stray tool pair on an AGENT draft to null (over-fire guard)", () => {
    const raw = '{"name": "x", "cronExpression": "0 9 * * *", "prompt": "y", "action": "agent", "toolServer": "muse.time", "toolName": "now"}';
    const result = parseFlowDraftResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.toolServer).toBeNull();
      expect(result.value.toolName).toBeNull();
    }
  });
});

describe("buildFlowDraftPrompt — draftable tools", () => {
  it("agent-only prompt (no tools) pins action to \"agent\" and never mentions an Available tools list", () => {
    const prompt = buildFlowDraftPrompt("daily brief at 9am");
    expect(prompt.system).toContain('"action": "agent"');
    expect(prompt.system).not.toContain("Available tools");
  });

  it("with tools, the system prompt lists each server.tool with its description and carries the tool few-shot", () => {
    const prompt = buildFlowDraftPrompt("매시간 현재 시각 기록해줘", [
      { description: "Current time", server: "muse.time", tool: "now" }
    ]);
    expect(prompt.system).toContain("Available tools:");
    expect(prompt.system).toContain("muse.time.now — Current time");
    expect(prompt.system).toContain('"toolServer": "muse.time"');
  });
});

describe("parseCurrentDraftInput", () => {
  const VALID = {
    cronExpression: "0 9 * * *",
    name: "아침 브리핑",
    notifyChannel: null,
    prompt: "오늘 일정을 요약해서 알려줘",
    retry: false
  };

  it("accepts the legacy 5-field shape, normalizing it to an agent draft (back-compat)", () => {
    const result = parseCurrentDraftInput(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ ...VALID, action: "agent", toolArguments: {}, toolName: null, toolServer: null });
    }
  });

  it("accepts a tool currentDraft (action/toolServer/toolName), normalizing prompt to blank", () => {
    const result = parseCurrentDraftInput({
      ...VALID,
      action: "tool",
      prompt: "",
      toolName: "now",
      toolServer: "muse.time"
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action).toBe("tool");
      expect(result.value.toolServer).toBe("muse.time");
      expect(result.value.toolName).toBe("now");
      expect(result.value.prompt).toBe("");
    }
  });

  it("rejects a tool currentDraft with a missing tool pair", () => {
    const result = parseCurrentDraftInput({ ...VALID, action: "tool", toolName: null, toolServer: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("toolServer");
    }
  });

  it("rejects a non-object (array, string, null, number)", () => {
    expect(parseCurrentDraftInput(null).ok).toBe(false);
    expect(parseCurrentDraftInput("nope").ok).toBe(false);
    expect(parseCurrentDraftInput(42).ok).toBe(false);
    expect(parseCurrentDraftInput([VALID]).ok).toBe(false);
  });

  it("rejects an unknown extra field rather than silently stripping it", () => {
    const result = parseCurrentDraftInput({ ...VALID, extraField: "sneaky" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("extraField");
    }
  });

  it("rejects a currentDraft missing a required key", () => {
    const { retry: _retry, ...withoutRetry } = VALID;
    const result = parseCurrentDraftInput(withoutRetry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("retry");
    }
  });

  it("rejects a wrong-typed field (retry as a string, cronExpression as a number)", () => {
    expect(parseCurrentDraftInput({ ...VALID, retry: "false" }).ok).toBe(false);
    expect(parseCurrentDraftInput({ ...VALID, cronExpression: 9 }).ok).toBe(false);
  });

  it("rejects an invalid (but 5-field-shaped) cron expression", () => {
    const result = parseCurrentDraftInput({ ...VALID, cronExpression: "99 99 99 99 99" });
    expect(result.ok).toBe(false);
  });

  it("normalizes a blank notifyChannel string to null", () => {
    const result = parseCurrentDraftInput({ ...VALID, notifyChannel: "   " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.notifyChannel).toBeNull();
    }
  });
});

const URL_PARSE_TOOL = {
  description: "Parses a URL into components.",
  inputSchema: {
    properties: { url: { description: "The URL to parse, e.g. 'https://example.com/a?b=1'", type: "string" } },
    required: ["url"],
    type: "object"
  },
  server: "muse.url",
  tool: "parse"
} as const;

const TIME_NOW_TOOL = { description: "Returns the current date/time.", server: "muse.time", tool: "now" } as const;

describe("tool-argument drafting", () => {
  it("the system prompt lists each schema-bearing tool's parameters with description", () => {
    const prompt = buildFlowDraftPrompt("x", [URL_PARSE_TOOL, TIME_NOW_TOOL]);
    expect(prompt.system).toContain("toolArguments");
    expect(prompt.system).toContain("url: string");
    expect(prompt.system).toContain("The URL to parse");
  });

  it("accepts a tool draft whose toolArguments match the tool's schema", () => {
    const raw = '{"name": "URL 파싱", "cronExpression": "0 * * * *", "prompt": "", "notifyChannel": null, "retry": false, "action": "tool", "toolServer": "muse.url", "toolName": "parse", "toolArguments": {"url": "https://news.ycombinator.com"}}';
    const result = parseFlowDraftResponse(raw, { allowedTools: [URL_PARSE_TOOL, TIME_NOW_TOOL] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.toolArguments).toEqual({ url: "https://news.ycombinator.com" });
    }
  });

  it("rejects a fabricated argument key the tool's schema does not declare", () => {
    const raw = '{"name": "URL 파싱", "cronExpression": "0 * * * *", "prompt": "", "notifyChannel": null, "retry": false, "action": "tool", "toolServer": "muse.url", "toolName": "parse", "toolArguments": {"url": "https://a.com", "depth": 3}}';
    const result = parseFlowDraftResponse(raw, { allowedTools: [URL_PARSE_TOOL] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("depth");
    }
  });

  it("rejects a tool draft missing a required argument", () => {
    const raw = '{"name": "URL 파싱", "cronExpression": "0 * * * *", "prompt": "", "notifyChannel": null, "retry": false, "action": "tool", "toolServer": "muse.url", "toolName": "parse", "toolArguments": {}}';
    const result = parseFlowDraftResponse(raw, { allowedTools: [URL_PARSE_TOOL] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("url");
    }
  });

  it("rejects a declared-type mismatch (string schema, number value)", () => {
    const raw = '{"name": "URL 파싱", "cronExpression": "0 * * * *", "prompt": "", "notifyChannel": null, "retry": false, "action": "tool", "toolServer": "muse.url", "toolName": "parse", "toolArguments": {"url": 42}}';
    const result = parseFlowDraftResponse(raw, { allowedTools: [URL_PARSE_TOOL] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("url");
    }
  });

  it("defaults toolArguments to {} for a schema-less tool and for agent drafts", () => {
    const toolRaw = '{"name": "시각 기록", "cronExpression": "0 * * * *", "prompt": "", "notifyChannel": null, "retry": false, "action": "tool", "toolServer": "muse.time", "toolName": "now"}';
    const toolResult = parseFlowDraftResponse(toolRaw, { allowedTools: [TIME_NOW_TOOL] });
    expect(toolResult.ok).toBe(true);
    if (toolResult.ok) {
      expect(toolResult.value.toolArguments).toEqual({});
    }
    const agentRaw = '{"name": "브리핑", "cronExpression": "0 9 * * *", "prompt": "요약해줘", "notifyChannel": null, "retry": false, "action": "agent", "toolServer": null, "toolName": null, "toolArguments": {"stray": 1}}';
    const agentResult = parseFlowDraftResponse(agentRaw);
    expect(agentResult.ok).toBe(true);
    if (agentResult.ok) {
      expect(agentResult.value.toolArguments).toEqual({});
    }
  });

  it("rejects a non-object toolArguments", () => {
    const raw = '{"name": "URL 파싱", "cronExpression": "0 * * * *", "prompt": "", "notifyChannel": null, "retry": false, "action": "tool", "toolServer": "muse.url", "toolName": "parse", "toolArguments": ["https://a.com"]}';
    const result = parseFlowDraftResponse(raw, { allowedTools: [URL_PARSE_TOOL] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("toolArguments");
    }
  });

  it("parseCurrentDraftInput accepts toolArguments on a tool draft and rejects a non-object", () => {
    const good = parseCurrentDraftInput({
      action: "tool",
      cronExpression: "0 * * * *",
      name: "URL 파싱",
      notifyChannel: null,
      prompt: "",
      retry: false,
      toolArguments: { url: "https://a.com" },
      toolName: "parse",
      toolServer: "muse.url"
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.toolArguments).toEqual({ url: "https://a.com" });
    }
    const bad = parseCurrentDraftInput({
      action: "tool",
      cronExpression: "0 * * * *",
      name: "URL 파싱",
      notifyChannel: null,
      prompt: "",
      retry: false,
      toolArguments: "url=a",
      toolName: "parse",
      toolServer: "muse.url"
    });
    expect(bad.ok).toBe(false);
  });
});
