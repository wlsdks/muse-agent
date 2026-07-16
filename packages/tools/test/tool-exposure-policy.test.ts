import { describe, expect, it } from "vitest";

import { createDefaultToolExposurePolicy, type MuseTool, type ToolExposureContext } from "../src/index.js";

const tool = (
  name: string,
  opts: { risk?: "read" | "write" | "execute"; scopes?: string[]; keywords?: string[] } = {},
): MuseTool => ({
  definition: {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    risk: opts.risk ?? "read",
    ...(opts.scopes ? { scopes: opts.scopes } : {}),
    ...(opts.keywords ? { keywords: opts.keywords } : {}),
  },
  execute: () => "ok",
});

const select = (tools: MuseTool[], context: ToolExposureContext, options = {}) => {
  const result = createDefaultToolExposurePolicy(options).select(tools, context);
  return {
    tools: result.tools.map((t) => t.definition.name),
    blocked: result.blocked.map((b) => `${b.toolName}:${b.code}`),
  };
};

describe("DefaultToolExposurePolicy.select", () => {
  it("exposes a relevant read tool (empty prompt = relevant to everything)", () => {
    expect(select([tool("weather_get", { keywords: ["weather"] })], {})).toEqual({
      tools: ["weather_get"],
      blocked: [],
    });
  });

  it("blocks a tool outside a non-empty allowed set", () => {
    expect(select([tool("a"), tool("b")], { allowedToolNames: ["a"], prompt: "" })).toEqual({
      tools: ["a"],
      blocked: ["b:not_allowed"],
    });
  });

  it("blocks an explicitly forbidden tool", () => {
    expect(select([tool("a")], { forbiddenToolNames: ["a"], prompt: "" })).toEqual({
      tools: [],
      blocked: ["a:forbidden"],
    });
  });

  it("blocks a tool that hit the repeated-call limit (default 3, configurable)", () => {
    expect(select([tool("a")], { recentToolNames: ["a", "a", "a"], prompt: "" }).blocked).toEqual([
      "a:repeat_limit_exceeded",
    ]);
    expect(select([tool("a")], { recentToolNames: ["a"], prompt: "" }, { maxRepeatedToolCalls: 1 }).blocked).toEqual([
      "a:repeat_limit_exceeded",
    ]);
    expect(select([tool("a")], { recentToolNames: ["a"], prompt: "" }, { maxRepeatedToolCalls: 1.5 }).tools).toEqual([
      "a",
    ]);
    expect(select([tool("a")], { recentToolNames: ["a", "a"], prompt: "" }, { maxRepeatedToolCalls: 1.5 }).blocked).toEqual([
      "a:repeat_limit_exceeded",
    ]);
  });

  it("blocks execute/local tools unless localMode is on", () => {
    expect(select([tool("run", { risk: "execute" })], { prompt: "" }).blocked).toEqual([
      "run:local_execution_unavailable",
    ]);
    expect(select([tool("scoped", { scopes: ["local"] })], { prompt: "" }).blocked).toEqual([
      "scoped:local_execution_unavailable",
    ]);
    expect(select([tool("run", { risk: "execute" })], { prompt: "", localMode: true })).toEqual({
      tools: ["run"],
      blocked: [],
    });
  });

  it("blocks a write tool without a clear workspace-mutation prompt, allows it with one or with the override", () => {
    const write = [tool("edit_document", { risk: "write", keywords: ["edit", "document"] })];
    // "show me the document" is relevant (keyword "document") but NOT a
    // mutation prompt, so the write gate fires; the override lifts it.
    expect(select(write, { prompt: "show me the document" }).blocked).toEqual([
      "edit_document:write_without_mutation_intent",
    ]);
    expect(select(write, { prompt: "edit the document" })).toEqual({ tools: ["edit_document"], blocked: [] });
    expect(select(write, { prompt: "show me the document" }, { allowWriteWithoutMutationIntent: true })).toEqual({
      tools: ["edit_document"],
      blocked: [],
    });
  });

  it("blocks a tool irrelevant to the prompt", () => {
    expect(select([tool("weather", { keywords: ["weather"] })], { prompt: "tell me about databases" }).blocked).toEqual([
      "weather:irrelevant_to_prompt",
    ]);
  });

  it("caps the exposed set at maxTools and blocks the overflow", () => {
    expect(select([tool("a"), tool("b"), tool("c")], { prompt: "", maxTools: 2 })).toEqual({
      tools: ["a", "b"],
      blocked: ["c:max_tool_count_exceeded"],
    });
    expect(select([tool("a")], { prompt: "", maxTools: 0 }).blocked).toEqual(["a:max_tool_count_exceeded"]);
  });

  it("fails closed for non-finite per-turn caps and retains the repeat cap for invalid options", () => {
    for (const maxTools of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(select([tool("a")], { prompt: "", maxTools })).toEqual({
        tools: [],
        blocked: ["a:max_tool_count_exceeded"],
      });
    }

    for (const maxRepeatedToolCalls of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(
        select([tool("a")], { prompt: "", recentToolNames: ["a", "a", "a"] }, { maxRepeatedToolCalls })
      ).toEqual({
        tools: [],
        blocked: ["a:repeat_limit_exceeded"],
      });
    }
  });

  it("relevance-first: a RELEVANT write tool wins its slot over marginally-relevant reads", () => {
    // Risk-first ranking let every read outrank every write, so the action tool
    // (add_task) fell off the maxTools cliff and the local model never saw it —
    // it then FABRICATED "added it" without calling any tool. Relevance must
    // decide the slot; risk is only a tiebreaker. `add a task` scores add_task
    // 2 (add+task) vs the reads' 1 (task), so the write is exposed first.
    const add = tool("add_task", { risk: "write", keywords: ["add", "task", "todo"] });
    const reads = ["alpha", "bravo", "charlie", "delta"].map((n) => tool(n, { keywords: ["task"] }));
    const res = select([...reads, add], { prompt: "add a task", maxTools: 1 }, { allowWriteWithoutMutationIntent: true });
    expect(res.tools).toEqual(["add_task"]);
  });

  it("relevance tie → risk is the tiebreaker (read before write)", () => {
    const read = tool("read_x", { risk: "read", keywords: ["thing"] });
    const write = tool("write_x", { risk: "write", keywords: ["thing"] });
    const res = select([write, read], { prompt: "thing", maxTools: 1 }, { allowWriteWithoutMutationIntent: true });
    expect(res.tools).toEqual(["read_x"]); // equal relevance → safer read wins
  });
});

describe("single-character CJK keywords match exactly, never by containment", () => {
  const weatherish: MuseTool = {
    definition: {
      description: "d", inputSchema: { properties: {}, type: "object" },
      keywords: ["비", "날씨"], name: "weatherish", risk: "read"
    },
    execute: async () => ({})
  };
  const notesish: MuseTool = {
    definition: {
      description: "d", inputSchema: { properties: {}, type: "object" },
      keywords: ["노트", "비밀번호"], name: "notesish", risk: "read"
    },
    execute: async () => ({})
  };

  it("'비' does NOT match '비밀번호' — the wifi-password prompt must not rank weather", () => {
    const policy = createDefaultToolExposurePolicy();
    const selection = policy.select([weatherish, notesish], { prompt: "내 노트에서 사무실 와이파이 비밀번호 찾아줘" });
    expect(selection.blocked.map((b) => b.toolName)).toContain("weatherish");
    expect(selection.tools.map((t) => t.definition.name)).toEqual(["notesish"]);
  });

  it("'비' still matches the exact token ('비 와?')", () => {
    const policy = createDefaultToolExposurePolicy();
    const selection = policy.select([weatherish], { prompt: "오늘 비 와?" });
    expect(selection.tools.map((t) => t.definition.name)).toEqual(["weatherish"]);
  });

  it("multi-char CJK keywords keep containment (particle attachment: 비밀번호를)", () => {
    const policy = createDefaultToolExposurePolicy();
    const selection = policy.select([notesish], { prompt: "비밀번호를 알려줘" });
    expect(selection.tools.map((t) => t.definition.name)).toEqual(["notesish"]);
  });
});
