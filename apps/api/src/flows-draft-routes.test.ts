import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { FlowDraftPrompt } from "./flows-draft-compile.js";
import { registerFlowDraftRoutes, type GenerateFlowDraft } from "./flows-draft-routes.js";

const VALID_JSON = '{"name": "아침 일정 요약", "cronExpression": "0 9 * * *", "prompt": "오늘 일정을 요약해서 알려줘", "notifyChannel": null, "retry": false}';

function serverWith(generateDraft: GenerateFlowDraft) {
  const server = Fastify();
  registerFlowDraftRoutes(server, { authService: undefined, generateDraft });
  return server;
}

describe("POST /api/flows/draft", () => {
  it("returns the parsed draft for a clean JSON response, calling the model exactly once", async () => {
    const generateDraft = vi.fn(async () => VALID_JSON);
    const server = serverWith(generateDraft);
    const res = await server.inject({
      method: "POST",
      payload: { text: "매일 아침 9시에 일정 요약해서 알려줘" },
      url: "/api/flows/draft"
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      draft: {
        action: "agent",
        cronExpression: "0 9 * * *",
        name: "아침 일정 요약",
        notifyChannel: null,
        prompt: "오늘 일정을 요약해서 알려줘",
        retry: false,
        toolArguments: {},
        toolName: null,
        toolServer: null
      }
    });
    expect(generateDraft).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it("extracts the JSON object out of sloppy prose", async () => {
    const generateDraft = vi.fn(async () => `Sure!\n${VALID_JSON}\nHope that helps.`);
    const server = serverWith(generateDraft);
    const res = await server.inject({ method: "POST", payload: { text: "아침 브리핑" }, url: "/api/flows/draft" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { draft: { name: string } };
    expect(body.draft.name).toBe("아침 일정 요약");
    await server.close();
  });

  it("repairs once on an invalid cron, then succeeds — the retry prompt carries the validation error", async () => {
    let call = 0;
    const generateDraft = vi.fn(async (prompt: FlowDraftPrompt) => {
      call += 1;
      if (call === 1) {
        expect(prompt.user).not.toContain("invalid");
        return '{"name": "x", "cronExpression": "bad", "prompt": "y"}';
      }
      expect(prompt.user).toContain("cronExpression must be a 5-field cron expression");
      return VALID_JSON;
    });
    const server = serverWith(generateDraft);
    const res = await server.inject({ method: "POST", payload: { text: "아침 브리핑" }, url: "/api/flows/draft" });
    expect(res.statusCode).toBe(200);
    expect(generateDraft).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("fails honestly with 422 + the reason + a truncated raw body when both attempts are invalid", async () => {
    const generateDraft = vi.fn(async () => "I refuse to answer in JSON.");
    const server = serverWith(generateDraft);
    const res = await server.inject({ method: "POST", payload: { text: "아침 브리핑" }, url: "/api/flows/draft" });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string; raw: string };
    expect(body.error).toContain("JSON object");
    expect(body.raw).toContain("I refuse to answer in JSON.");
    expect(generateDraft).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("surfaces a provider throw verbatim (no cloud fallback), never creating a job", async () => {
    const generateDraft = vi.fn(async () => {
      throw new Error("Ollama unreachable: connect ECONNREFUSED 127.0.0.1:11434");
    });
    const server = serverWith(generateDraft);
    const res = await server.inject({ method: "POST", payload: { text: "아침 브리핑" }, url: "/api/flows/draft" });
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("Ollama unreachable: connect ECONNREFUSED 127.0.0.1:11434");
    expect(generateDraft).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it("rejects an empty or over-long text with 400 before ever calling the model", async () => {
    const generateDraft = vi.fn(async () => VALID_JSON);
    const server = serverWith(generateDraft);
    const empty = await server.inject({ method: "POST", payload: { text: "" }, url: "/api/flows/draft" });
    expect(empty.statusCode).toBe(400);
    const tooLong = await server.inject({ method: "POST", payload: { text: "x".repeat(501) }, url: "/api/flows/draft" });
    expect(tooLong.statusCode).toBe(400);
    expect(generateDraft).not.toHaveBeenCalled();
    await server.close();
  });

  it("401s when auth is enabled and the request carries no identity", async () => {
    const server = Fastify();
    registerFlowDraftRoutes(server, { authService: {} as never, generateDraft: vi.fn(async () => VALID_JSON) });
    const res = await server.inject({ method: "POST", payload: { text: "아침 브리핑" }, url: "/api/flows/draft" });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});

const CURRENT_DRAFT = {
  cronExpression: "0 9 * * *",
  name: "아침 브리핑",
  notifyChannel: null,
  prompt: "오늘 일정을 요약해서 알려줘",
  retry: false
};

// What the route's revision prompt actually echoes: parseCurrentDraftInput's
// normalized payload (the legacy 5-field client shape + defaulted action/tool
// fields), NOT the raw client body.
const NORMALIZED_CURRENT_DRAFT = {
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

describe("POST /api/flows/draft — revision mode (currentDraft present)", () => {
  it("returns the FULL revised draft, calling the model exactly once when the revision echoes correctly", async () => {
    const revised = '{"name": "아침 브리핑", "cronExpression": "30 8 * * *", "prompt": "오늘 일정을 요약해서 알려줘", "notifyChannel": null, "retry": false, "action": "agent", "toolServer": null, "toolName": null}';
    const generateDraft = vi.fn(async (prompt: FlowDraftPrompt) => {
      expect(prompt.system).toContain("FULL updated JSON");
      expect(prompt.user).toContain(JSON.stringify(NORMALIZED_CURRENT_DRAFT));
      expect(prompt.user).toContain("8시 반으로 바꿔줘");
      return revised;
    });
    const server = serverWith(generateDraft);
    const res = await server.inject({
      method: "POST",
      payload: { currentDraft: CURRENT_DRAFT, text: "8시 반으로 바꿔줘" },
      url: "/api/flows/draft"
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      draft: {
        action: "agent",
        cronExpression: "30 8 * * *",
        name: "아침 브리핑",
        notifyChannel: null,
        prompt: "오늘 일정을 요약해서 알려줘",
        retry: false,
        toolArguments: {},
        toolName: null,
        toolServer: null
      }
    });
    expect(generateDraft).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it("field-preservation: changing ONLY the cron leaves prompt/notifyChannel exactly as the currentDraft had them", async () => {
    const priorDraft = { ...CURRENT_DRAFT, notifyChannel: "telegram:123", retry: true };
    const revised = JSON.stringify({ ...priorDraft, action: "agent", cronExpression: "0 20 * * *", toolName: null, toolServer: null });
    const generateDraft = vi.fn(async () => revised);
    const server = serverWith(generateDraft);
    const res = await server.inject({
      method: "POST",
      payload: { currentDraft: priorDraft, text: "저녁 8시로 바꿔줘" },
      url: "/api/flows/draft"
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { draft: typeof priorDraft };
    expect(body.draft.cronExpression).toBe("0 20 * * *");
    expect(body.draft.prompt).toBe(priorDraft.prompt);
    expect(body.draft.notifyChannel).toBe("telegram:123");
    expect(body.draft.retry).toBe(true);
    await server.close();
  });

  it("a fake provider that DROPS a field on both attempts fails honestly with 422 — the revision schema requires all 5 keys present", async () => {
    // Drops `retry` entirely (not even `null`) on every attempt — a revision
    // response must echo back the full shape, never rely on a silent default.
    const droppedField = '{"name": "아침 브리핑", "cronExpression": "0 9 * * *", "prompt": "오늘 일정을 요약해서 알려줘", "notifyChannel": null}';
    const generateDraft = vi.fn(async () => droppedField);
    const server = serverWith(generateDraft);
    const res = await server.inject({
      method: "POST",
      payload: { currentDraft: CURRENT_DRAFT, text: "재시도 붙여줘" },
      url: "/api/flows/draft"
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain("retry");
    expect(generateDraft).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("repairs once on a revision that drops a field, then succeeds when the repaired answer carries all 5", async () => {
    let call = 0;
    const generateDraft = vi.fn(async (prompt: FlowDraftPrompt) => {
      call += 1;
      if (call === 1) {
        expect(prompt.user).not.toContain("invalid");
        return '{"name": "아침 브리핑", "cronExpression": "0 9 * * *", "prompt": "오늘 일정을 요약해서 알려줘"}';
      }
      expect(prompt.user).toContain("missing required field");
      expect(prompt.user).toContain(JSON.stringify(NORMALIZED_CURRENT_DRAFT));
      return '{"name": "아침 브리핑", "cronExpression": "0 9 * * *", "prompt": "오늘 일정을 요약해서 알려줘", "notifyChannel": null, "retry": true, "action": "agent"}';
    });
    const server = serverWith(generateDraft);
    const res = await server.inject({
      method: "POST",
      payload: { currentDraft: CURRENT_DRAFT, text: "재시도 붙여줘" },
      url: "/api/flows/draft"
    });
    expect(res.statusCode).toBe(200);
    expect(generateDraft).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("rejects an invalid currentDraft with 400 BEFORE ever calling the model", async () => {
    const generateDraft = vi.fn(async () => VALID_JSON);
    const server = serverWith(generateDraft);

    const missingField = await server.inject({
      method: "POST",
      payload: { currentDraft: { ...CURRENT_DRAFT, retry: undefined }, text: "8시 반으로 바꿔줘" },
      url: "/api/flows/draft"
    });
    expect(missingField.statusCode).toBe(400);

    const unknownField = await server.inject({
      method: "POST",
      payload: { currentDraft: { ...CURRENT_DRAFT, sneaky: true }, text: "8시 반으로 바꿔줘" },
      url: "/api/flows/draft"
    });
    expect(unknownField.statusCode).toBe(400);
    expect(JSON.parse(unknownField.body).error).toContain("sneaky");

    const wrongType = await server.inject({
      method: "POST",
      payload: { currentDraft: { ...CURRENT_DRAFT, retry: "yes" }, text: "8시 반으로 바꿔줘" },
      url: "/api/flows/draft"
    });
    expect(wrongType.statusCode).toBe(400);

    const notAnObject = await server.inject({
      method: "POST",
      payload: { currentDraft: "not-an-object", text: "8시 반으로 바꿔줘" },
      url: "/api/flows/draft"
    });
    expect(notAnObject.statusCode).toBe(400);

    expect(generateDraft).not.toHaveBeenCalled();
    await server.close();
  });
});

describe("POST /api/flows/draft — tool drafts (listDraftableTools wired)", () => {
  const TOOLS = [{ description: "Current time", server: "muse.time", tool: "now" }];

  function serverWithTools(generateDraft: GenerateFlowDraft) {
    const server = Fastify();
    registerFlowDraftRoutes(server, { authService: undefined, generateDraft, listDraftableTools: () => TOOLS });
    return server;
  }

  it("offers the tool list in the prompt and returns a validated tool draft", async () => {
    const generateDraft = vi.fn(async (prompt: FlowDraftPrompt) => {
      expect(prompt.system).toContain("Available tools:");
      expect(prompt.system).toContain("muse.time.now — Current time");
      return '{"name": "매시간 시각", "cronExpression": "0 * * * *", "prompt": "", "notifyChannel": null, "retry": false, "action": "tool", "toolServer": "muse.time", "toolName": "now"}';
    });
    const server = serverWithTools(generateDraft);
    const res = await server.inject({ method: "POST", payload: { text: "매시간 정각에 현재 시각 기록해줘" }, url: "/api/flows/draft" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { draft: { action: string; toolServer: string; toolName: string } };
    expect(body.draft.action).toBe("tool");
    expect(body.draft.toolServer).toBe("muse.time");
    expect(body.draft.toolName).toBe("now");
    await server.close();
  });

  it("rejects a tool pair outside the allowed list on both attempts with 422 (never a stored-but-unrunnable draft)", async () => {
    const bad = '{"name": "x", "cronExpression": "0 * * * *", "prompt": "", "notifyChannel": null, "retry": false, "action": "tool", "toolServer": "muse.messaging", "toolName": "send"}';
    const generateDraft = vi.fn(async () => bad);
    const server = serverWithTools(generateDraft);
    const res = await server.inject({ method: "POST", payload: { text: "메시지 보내줘" }, url: "/api/flows/draft" });
    expect(res.statusCode).toBe(422);
    expect((JSON.parse(res.body) as { error: string }).error).toContain("muse.messaging.send");
    expect(generateDraft).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("without listDraftableTools the prompt stays agent-only (no Available tools list)", async () => {
    const generateDraft = vi.fn(async (prompt: FlowDraftPrompt) => {
      expect(prompt.system).not.toContain("Available tools");
      return VALID_JSON;
    });
    const server = serverWith(generateDraft);
    const res = await server.inject({ method: "POST", payload: { text: "매일 아침 브리핑" }, url: "/api/flows/draft" });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});
