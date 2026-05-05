import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("api server", () => {
  it("reports health", async () => {
    const server = buildServer({ logger: false });

    const response = await server.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "muse-api",
      status: "ok"
    });
  });

  it("manages agent specs and resolves matching requests", async () => {
    const server = buildServer({ logger: false });

    const created = await server.inject({
      method: "POST",
      payload: {
        keywords: ["research", "sources"],
        name: "researcher",
        systemPrompt: "Use verifiable sources.",
        toolNames: ["web_search"]
      },
      url: "/agent-specs"
    });
    const resolved = await server.inject({
      method: "POST",
      payload: {
        text: "Research this with sources"
      },
      url: "/agent-specs/resolve"
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "researcher",
      systemPrompt: "Use verifiable sources.",
      toolNames: ["web_search"]
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({
      resolution: {
        confidence: 1,
        matchedKeywords: ["research", "sources"],
        name: "researcher",
        toolNames: ["web_search"]
      }
    });
  });

  it("manages runtime settings", async () => {
    const server = buildServer({ logger: false });

    const saved = await server.inject({
      method: "PUT",
      payload: {
        category: "guard",
        type: "number",
        updatedBy: "operator",
        value: "20"
      },
      url: "/settings/guard.rateLimit"
    });
    const fetched = await server.inject({
      method: "GET",
      url: "/settings/guard.rateLimit"
    });
    const listed = await server.inject({
      method: "GET",
      url: "/settings"
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      category: "guard",
      key: "guard.rateLimit",
      type: "number",
      updatedBy: "operator",
      value: "20"
    });
    expect(fetched.json()).toMatchObject({
      key: "guard.rateLimit",
      value: "20"
    });
    expect(listed.json()).toHaveLength(1);
  });

  it("returns typed errors for invalid management payloads", async () => {
    const server = buildServer({ logger: false });

    const invalidSpec = await server.inject({
      method: "POST",
      payload: {},
      url: "/agent-specs"
    });
    const invalidSetting = await server.inject({
      method: "PUT",
      payload: {},
      url: "/settings/model.default"
    });

    expect(invalidSpec.statusCode).toBe(400);
    expect(invalidSpec.json()).toMatchObject({ code: "INVALID_AGENT_SPEC" });
    expect(invalidSetting.statusCode).toBe(400);
    expect(invalidSetting.json()).toMatchObject({ code: "INVALID_RUNTIME_SETTING" });
  });
});
