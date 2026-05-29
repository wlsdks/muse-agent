import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

// Route-integration (backlog P2): the Spring-compat agent-spec route group.
// buildServer auto-creates a fresh InMemoryAgentSpecRegistry per instance and,
// with no authService bound, requireAuthenticated passes (personal-use default),
// so the full CRUD surface is exercisable end-to-end.
describe("api server: /api/admin/agent-specs + agent-card (compat)", () => {
  const servers: { close: () => Promise<unknown> }[] = [];
  const makeServer = () => {
    const s = buildServer({ logger: false });
    servers.push(s);
    return s;
  };
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

  it("serves the public agent card", async () => {
    expect((await makeServer().inject({ method: "GET", url: "/.well-known/agent-card.json" })).statusCode).toBe(200);
  });

  it("CRUDs an agent spec: empty → POST(201) → GET by id → system-prompt → DELETE(204)", async () => {
    const server = makeServer();
    expect((await server.inject({ method: "GET", url: "/api/admin/agent-specs" })).json()).toEqual([]);

    const created = await server.inject({
      method: "POST",
      payload: { description: "d", keywords: ["research"], mode: "plan_execute", name: "researcher" },
      url: "/api/admin/agent-specs",
    });
    expect(created.statusCode).toBe(201);
    const spec = created.json() as { id: string; name: string; mode: string };
    // the compat response upper-cases the mode enum
    expect(spec).toMatchObject({ enabled: true, keywords: ["research"], mode: "PLAN_EXECUTE", name: "researcher" });

    const got = await server.inject({ method: "GET", url: `/api/admin/agent-specs/${spec.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id: spec.id, name: "researcher" });

    expect((await server.inject({ method: "GET", url: `/api/admin/agent-specs/${spec.id}/system-prompt` })).statusCode).toBe(200);

    expect((await server.inject({ method: "DELETE", url: `/api/admin/agent-specs/${spec.id}` })).statusCode).toBe(204);
    expect((await server.inject({ method: "GET", url: "/api/admin/agent-specs" })).json()).toEqual([]);
  });

  it("rejects a duplicate name (409) and a no-name spec (400)", async () => {
    const server = makeServer();
    await server.inject({ method: "POST", payload: { name: "dup" }, url: "/api/admin/agent-specs" });
    expect((await server.inject({ method: "POST", payload: { name: "dup" }, url: "/api/admin/agent-specs" })).statusCode).toBe(409);
    expect((await server.inject({ method: "POST", payload: {}, url: "/api/admin/agent-specs" })).statusCode).toBe(400);
  });

  it("404s a GET for an unknown spec id", async () => {
    expect((await makeServer().inject({ method: "GET", url: "/api/admin/agent-specs/does-not-exist" })).statusCode).toBe(404);
  });
});
