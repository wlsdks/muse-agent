import { afterEach, describe, expect, it } from "vitest";

import { InMemoryAgentRunHistoryStore } from "@muse/runtime-state";

import { buildServer } from "../src/server.js";

// Route-integration (backlog P2): the Spring-compat session route group.
// /api/models is public (lists the configured models); the /api/sessions/*
// routes require an attached auth identity — with no authService bound, no
// identity is attached, so they fail closed with 401 (the real auth gate).
describe("api server: /api/models + /api/sessions/* (compat)", () => {
  const servers: { close: () => Promise<unknown> }[] = [];
  const makeServer = () => {
    const s = buildServer({ defaultModel: "diagnostic/smoke", historyStore: new InMemoryAgentRunHistoryStore(), logger: false, modelProviderId: "diagnostic" });
    servers.push(s);
    return s;
  };
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

  it("GET /api/models lists the configured models and flags the default", async () => {
    const res = await makeServer().inject({ method: "GET", url: "/api/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { defaultModel: string; models: { name: string; isDefault: boolean }[] };
    expect(body.defaultModel).toBe("diagnostic/smoke");
    expect(body.models.find((m) => m.name === "diagnostic/smoke")?.isDefault).toBe(true);
  });

  it.each([
    ["GET", "/api/sessions"],
    ["GET", "/api/sessions/abc"],
    ["GET", "/api/sessions/abc/export"],
    ["DELETE", "/api/sessions/abc"],
  ])("fails closed with 401 on %s %s when no auth identity is attached", async (method, url) => {
    const res = await makeServer().inject({ method: method as "GET" | "DELETE", url });
    expect(res.statusCode).toBe(401);
  });
});
