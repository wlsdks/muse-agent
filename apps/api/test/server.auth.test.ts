import { describe, expect, it } from "vitest";
import { InMemoryAgentRunHistoryStore } from "@muse/runtime-state";
import { buildServer } from "../src/server.js";
import { createAuthService } from "./helpers/test-auth.js";

describe("api server: auth + session ownership", () => {
  it("registers, authenticates, protects, and revokes auth sessions", async () => {
    const authService = createAuthService();
    const server = buildServer({ authService, logger: false, requireAuth: true });

    const registered = await server.inject({
      method: "POST",
      payload: {
        email: "first_account",
        name: "First",
        password: "password-1"
      },
      url: "/auth/register"
    });
    const token = registered.json().token as string;
    const protectedWithoutToken = await server.inject({
      method: "GET",
      url: "/agent-specs"
    });
    const me = await server.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/auth/me"
    });
    const logout = await server.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
      url: "/auth/logout"
    });
    const afterLogout = await server.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/auth/me"
    });

    expect(registered.statusCode).toBe(201);
    expect(registered.json().user).toMatchObject({ role: "admin" });
    expect(protectedWithoutToken.statusCode).toBe(401);
    expect(me.statusCode).toBe(200);
    expect(me.json().identity).toMatchObject({ email: "first_account", role: "admin" });
    expect(logout.json()).toEqual({ revoked: true });
  });

  it("serves Reactor-compatible auth DTOs on api auth aliases", async () => {
    const authService = createAuthService();
    const server = buildServer({ authService, logger: false, requireAuth: true });
    const email = ["compat", "example.invalid"].join("@");

    const invalidRegister = await server.inject({
      method: "POST",
      payload: { email: "invalid_email", name: "Compat", password: "short" },
      url: "/api/auth/register"
    });
    const registered = await server.inject({
      method: "POST",
      payload: { email, name: "Compat", password: "password-1" },
      url: "/api/auth/register"
    });
    const duplicate = await server.inject({
      method: "POST",
      payload: { email, name: "Compat", password: "password-1" },
      url: "/api/auth/register"
    });
    const token = registered.json().token as string;
    const me = await server.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/api/auth/me"
    });
    const logout = await server.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
      url: "/api/auth/logout"
    });
    const afterLogout = await server.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/api/auth/me"
    });

    expect(invalidRegister.statusCode).toBe(400);
    expect(registered.statusCode).toBe(201);
    expect(registered.json()).toMatchObject({
      error: null,
      user: {
        email,
        name: "Compat",
        role: "USER"
      }
    });
    expect(registered.json().user).not.toHaveProperty("adminScope");
    expect(registered.json()).not.toHaveProperty("expiresAt");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      error: "Email already registered",
      token: "",
      user: null
    });
    expect(me.json()).toMatchObject({
      email,
      name: "Compat",
      role: "USER"
    });
    expect(me.json()).not.toHaveProperty("adminScope");
    expect(me.json()).not.toHaveProperty("identity");
    expect(logout.json()).toEqual({ message: "Logged out" });
  });

  it("keeps api session ownership scoped to the authenticated user", async () => {
    const authService = createAuthService();
    const ownerEmail = ["owner", "example.invalid"].join("@");
    const memberEmail = ["member", "example.invalid"].join("@");
    const managerEmail = ["manager", "example.invalid"].join("@");
    const owner = authService.register({ email: ownerEmail, name: "Owner", password: "password-1" });
    const member = authService.register({ email: memberEmail, name: "Member", password: "password-1" });
    authService.register({ email: managerEmail, name: "Other", password: "password-1" });
    const memberLogin = authService.login(memberEmail, "password-1");
    const otherLogin = authService.login(managerEmail, "password-1");
    const historyStore = new InMemoryAgentRunHistoryStore();
    historyStore.createRun({
      id: "owner-run",
      input: "owner prompt",
      model: "provider/model",
      provider: "provider",
      userId: owner.user.id
    });
    historyStore.createRun({
      id: "member-run",
      input: "member prompt",
      model: "provider/model",
      provider: "provider",
      userId: member.user.id
    });
    historyStore.createRun({
      id: "orphan-run",
      input: "orphan prompt",
      model: "provider/model",
      provider: "provider"
    });
    const server = buildServer({ authService, historyStore, logger: false, requireAuth: true });
    const headers = { authorization: `Bearer ${memberLogin?.token ?? ""}` };
    const otherHeaders = { authorization: `Bearer ${otherLogin?.token ?? ""}` };

    const unauthenticatedSessions = await server.inject({
      method: "GET",
      url: "/api/sessions"
    });
    const spoofedList = await server.inject({
      headers,
      method: "GET",
      url: `/api/sessions?userId=${owner.user.id}`
    });
    const clampedSessions = await server.inject({
      headers,
      method: "GET",
      url: "/api/sessions?limit=500"
    });
    const forbiddenDelete = await server.inject({
      headers,
      method: "DELETE",
      url: "/api/sessions/owner-run"
    });
    const otherForbiddenDetail = await server.inject({
      headers: otherHeaders,
      method: "GET",
      url: "/api/sessions/owner-run"
    });
    const otherForbiddenExport = await server.inject({
      headers: otherHeaders,
      method: "GET",
      url: "/api/sessions/owner-run/export"
    });
    const orphanDetail = await server.inject({
      headers,
      method: "GET",
      url: "/api/sessions/orphan-run"
    });
    const orphanDelete = await server.inject({
      headers,
      method: "DELETE",
      url: "/api/sessions/orphan-run"
    });
    const markdownExport = await server.inject({
      headers,
      method: "GET",
      url: "/api/sessions/member-run/export?format=md"
    });
    const ownDelete = await server.inject({
      headers,
      method: "DELETE",
      url: "/api/sessions/member-run"
    });

    expect(unauthenticatedSessions.statusCode).toBe(401);
    expect(unauthenticatedSessions.json()).toMatchObject({
      error: "인증이 필요합니다",
      timestamp: expect.any(String)
    });
    expect(unauthenticatedSessions.json()).not.toHaveProperty("code");
    expect(spoofedList.json()).toMatchObject({
      items: [{ preview: "member prompt", sessionId: "member-run" }],
      total: 1
    });
    expect(clampedSessions.json()).toMatchObject({
      limit: 200,
      total: 1
    });
    expect(forbiddenDelete.statusCode).toBe(403);
    expect(forbiddenDelete.json()).toMatchObject({
      error: "세션 접근이 거부되었습니다",
      timestamp: expect.any(String)
    });
    expect(forbiddenDelete.json()).not.toHaveProperty("code");
    expect(otherLogin).toBeDefined();
    expect(otherForbiddenDetail.statusCode).toBe(403);
    expect(otherForbiddenExport.statusCode).toBe(403);
    expect(orphanDetail.statusCode).toBe(403);
    expect(orphanDetail.json()).toMatchObject({
      error: "세션 접근이 거부되었습니다",
      timestamp: expect.any(String)
    });
    expect(orphanDetail.json()).not.toHaveProperty("code");
    expect(orphanDelete.statusCode).toBe(403);
    expect(orphanDelete.json()).toMatchObject({
      error: "세션 접근이 거부되었습니다",
      timestamp: expect.any(String)
    });
    expect(orphanDelete.json()).not.toHaveProperty("code");
    expect(markdownExport.statusCode).toBe(200);
    expect(markdownExport.headers["content-type"]).toContain("text/markdown");
    expect(markdownExport.body).toContain("# Conversation: member-run");
    expect(ownDelete.statusCode).toBe(204);
  });
});

