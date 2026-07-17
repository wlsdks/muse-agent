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
        cronExpression: "0 9 * * *",
        name: "아침 일정 요약",
        notifyChannel: null,
        prompt: "오늘 일정을 요약해서 알려줘",
        retry: false
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
