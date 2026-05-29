import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

// Route-integration (backlog P2): the Spring-compat user-memory route group.
// buildServer auto-creates a fresh InMemoryUserMemoryStore per instance, so each
// test gets an isolated store. Auth is disabled (personal-use default), but the
// route still forbids the reserved "anonymous" / blank user id.
describe("api server: /api/user-memory/* (compat)", () => {
  const servers: { close: () => Promise<unknown> }[] = [];
  const makeServer = () => {
    const s = buildServer({ logger: false });
    servers.push(s);
    return s;
  };
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

  it("POST /api/error-report always acknowledges with 204", async () => {
    expect((await makeServer().inject({ method: "POST", payload: { message: "boom" }, url: "/api/error-report" })).statusCode).toBe(204);
  });

  it("forbids the reserved anonymous / blank user id (403)", async () => {
    const server = makeServer();
    expect((await server.inject({ method: "GET", url: "/api/user-memory/anonymous" })).statusCode).toBe(403);
  });

  it("returns 404 for a user with no stored memory yet", async () => {
    const res = await makeServer().inject({ method: "GET", url: "/api/user-memory/u1" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toContain("not found");
  });

  it("PUT facts + preferences round-trip: writes are reflected by a subsequent GET", async () => {
    const server = makeServer();
    expect((await server.inject({ method: "PUT", payload: { key: "home_city", value: "Seoul" }, url: "/api/user-memory/u1/facts" })).json()).toEqual({ updated: true });
    expect((await server.inject({ method: "PUT", payload: { key: "reply_style", value: "concise" }, url: "/api/user-memory/u1/preferences" })).statusCode).toBe(200);

    const got = await server.inject({ method: "GET", url: "/api/user-memory/u1" });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ facts: { home_city: "Seoul" }, preferences: { reply_style: "concise" } });
  });

  it("rejects a PUT missing key or value (400)", async () => {
    const res = await makeServer().inject({ method: "PUT", payload: { key: "home_city" }, url: "/api/user-memory/u1/facts" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("key and value");
  });

  it("DELETE clears the user's memory (204), and a later GET is 404 again", async () => {
    const server = makeServer();
    await server.inject({ method: "PUT", payload: { key: "home_city", value: "Seoul" }, url: "/api/user-memory/u1/facts" });
    expect((await server.inject({ method: "DELETE", url: "/api/user-memory/u1" })).statusCode).toBe(204);
    expect((await server.inject({ method: "GET", url: "/api/user-memory/u1" })).statusCode).toBe(404);
  });
});
