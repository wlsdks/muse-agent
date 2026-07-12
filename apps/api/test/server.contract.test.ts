import { describe, expect, it } from "vitest";
import {
  Auth,
  DefaultAuthProvider,
  InMemoryUserStore,
  JwtTokenProvider
} from "@muse/auth";
import { buildServer } from "../src/server.js";

describe("api server: web contract + manifest", () => {
  it("reports health", async () => {
    const server = buildServer({ logger: false });

    const response = await server.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "muse-api",
      status: "ok"
    });
    const payload = response.json() as { pid: number; version: string; startedAtIso: string };
    expect(payload.pid).toBeGreaterThan(0);
    expect(typeof payload.version).toBe("string");
    expect(Number.isFinite(Date.parse(payload.startedAtIso))).toBe(true);
  });

  it("applies Muse compatible web contract headers", async () => {
    const server = buildServer({ logger: false });

    const response = await server.inject({
      headers: { "x-request-id": "request-1" },
      method: "GET",
      url: "/health"
    });
    const sensitive = await server.inject({
      method: "POST",
      payload: { message: "Hello" },
      url: "/api/chat"
    });

    expect(response.headers["x-request-id"]).toBe("request-1");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toBe("default-src 'self'");
    expect(response.headers["x-xss-protection"]).toBe("0");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(response.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains; preload");
    expect(response.headers["permissions-policy"]).toBe("geolocation=(), camera=(), microphone=(), payment=()");
    expect(response.headers["x-muse-api-version"]).toBe("1");
    expect(response.headers["x-muse-api-supported-versions"]).toBe("1");
    expect(sensitive.headers["cache-control"]).toBe("no-store");
  });

  it("rejects unsupported compat API versions before route handling", async () => {
    const server = buildServer({ logger: false });

    const response = await server.inject({
      headers: { "x-muse-api-version": "999" },
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["x-muse-api-version"]).toBe("1");
    expect(response.headers["x-muse-api-supported-versions"]).toBe("1");
    expect(response.json()).toMatchObject({
      error: "Unsupported API version '999'. Supported versions: 1"
    });
  });

  it("applies configured CORS headers and answers preflight requests", async () => {
    const server = buildServer({
      cors: {
        allowCredentials: true,
        allowedOrigins: ["http://127.0.0.1:5173"]
      },
      logger: false
    });

    const response = await server.inject({
      headers: {
        "access-control-request-headers": "authorization,content-type",
        "access-control-request-method": "POST",
        origin: "http://127.0.0.1:5173"
      },
      method: "OPTIONS",
      url: "/api/chat"
    });
    const blocked = await server.inject({
      headers: { origin: "https://blocked.example" },
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    expect(response.headers["access-control-allow-headers"]).toContain("authorization");
    expect(blocked.headers).not.toHaveProperty("access-control-allow-origin");
  });

  it("generates an OpenAPI document from registered API routes", async () => {
    const server = buildServer({ logger: false });

    const response = await server.inject({
      method: "GET",
      url: "/v3/api-docs"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      info: {
        title: "Muse API",
        version: "0.0.0"
      },
      openapi: "3.1.0",
      paths: {
        "/api/chat": expect.any(Object)
      }
    });
  });

  it("manages agent specs and resolves matching requests", async () => {
    const server = buildServer({ logger: false });

    const created = await server.inject({
      method: "POST",
      payload: {
        description: "Research with verifiable sources.",
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
    const card = await server.inject({
      method: "GET",
      url: "/.well-known/agent-card.json"
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      description: "Research with verifiable sources.",
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
    expect(card.json()).toMatchObject({
      description: "Muse AI Agent",
      name: "Muse",
      supportedInputFormats: ["text", "json"],
      supportedOutputFormats: ["text", "json", "yaml"],
      version: "1.0.0"
    });
    expect(card.json().capabilities).toEqual(expect.arrayContaining([
      {
        description: "Available tool: web_search",
        inputSchema: null,
        kind: "tool",
        name: "web_search"
      },
      {
        description: "Research with verifiable sources.",
        inputSchema: null,
        kind: "persona",
        name: "persona:researcher"
      }
    ]));
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

  it("exposes a Muse runtime manifest at /api/muse/runtime", async () => {
    const previousLocales = process.env.MUSE_RESPONSE_LOCALES;
    process.env.MUSE_RESPONSE_LOCALES = "ko,en";
    try {
      const server = buildServer({
        defaultModel: "provider/model",
        logger: false,
        toolCatalogProvider: () => [
          { description: "read fs", name: "read_file", risk: "read" },
          { description: "write fs", name: "write_file", risk: "write" },
          { description: "spawn shell", name: "run_command", risk: "execute" },
          { description: "search docs", name: "search_docs", risk: "read" }
        ]
      });

      const response = await server.inject({ method: "GET", url: "/api/muse/runtime" });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        agentCore: { modelAgnostic: true, runner: "rust" },
        agentSpecs: { total: 0 },
        defaultModel: "provider/model",
        locales: { response: ["ko", "en"] },
        service: "muse-api",
        tools: { byRisk: { execute: 1, read: 2, write: 1 }, total: 4 }
      });
      expect(body.capabilities).toMatchObject({
        authEnabled: false,
        historyEnabled: false,
        mcpEnabled: false,
        modelProviderConfigured: false,
        schedulerEnabled: false
      });
    } finally {
      if (previousLocales === undefined) {
        delete process.env.MUSE_RESPONSE_LOCALES;
      } else {
        process.env.MUSE_RESPONSE_LOCALES = previousLocales;
      }
    }
  });

  it("falls back to ko,en when MUSE_RESPONSE_LOCALES is unset", async () => {
    const previousLocales = process.env.MUSE_RESPONSE_LOCALES;
    delete process.env.MUSE_RESPONSE_LOCALES;
    try {
      const server = buildServer({ logger: false });
      const response = await server.inject({ method: "GET", url: "/api/muse/runtime" });
      expect(response.statusCode).toBe(200);
      expect(response.json().locales.response).toEqual(["ko", "en"]);
    } finally {
      if (previousLocales !== undefined) {
        process.env.MUSE_RESPONSE_LOCALES = previousLocales;
      }
    }
  });

  it("exposes the loopback MCP catalog at /api/muse/loopback", async () => {
    const server = buildServer({ logger: false });
    const response = await server.inject({ method: "GET", url: "/api/muse/loopback" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      readonly total: number;
      readonly servers: readonly { readonly name: string; readonly optIn: boolean; readonly tools: readonly { readonly name: string }[]; readonly toolCount: number; readonly requires?: readonly string[] }[];
    };
    expect(body.total).toBe(13);
    const names = body.servers.map((entry) => entry.name).sort();
    expect(names).toEqual([
      "muse.crypto", "muse.diff", "muse.fetch", "muse.fs", "muse.json", "muse.math",
      "muse.messaging", "muse.regex", "muse.reminders", "muse.search", "muse.text", "muse.time", "muse.url"
    ]);
    const fs = body.servers.find((entry) => entry.name === "muse.fs")!;
    expect(fs.optIn).toBe(true);
    expect(fs.requires).toEqual(["allowedRoots (FilesystemMcpServerOptions.allowedRoots)"]);
    expect(fs.toolCount).toBe(3);
    expect(fs.tools.map((tool) => tool.name).sort()).toEqual(["list", "read", "stat"]);
    const messaging = body.servers.find((entry) => entry.name === "muse.messaging")!;
    expect(messaging.optIn).toBe(true);
    expect(messaging.tools.map((tool) => tool.name).sort()).toEqual(["inbox", "poll_all", "poll_now", "providers", "send"]);
    const time = body.servers.find((entry) => entry.name === "muse.time")!;
    expect(time.optIn).toBe(false);
    expect(time.requires).toBeUndefined();
  });

  it("/api/muse/loopback is reachable without auth even when requireAuth is on", async () => {
    const userStore = new InMemoryUserStore();
    const authService = new Auth({
      authProvider: new DefaultAuthProvider(userStore),
      jwt: new JwtTokenProvider({ jwtSecret: "0123456789abcdef0123456789abcdef" }),
      userStore
    });
    const server = buildServer({ authService, logger: false, requireAuth: true });
    const response = await server.inject({ method: "GET", url: "/api/muse/loopback" });
    expect(response.statusCode).toBe(200);
  });

  it("ignores unknown locale codes in MUSE_RESPONSE_LOCALES", async () => {
    const previousLocales = process.env.MUSE_RESPONSE_LOCALES;
    process.env.MUSE_RESPONSE_LOCALES = "ko,fr,de,en,en";
    try {
      const server = buildServer({ logger: false });
      const response = await server.inject({ method: "GET", url: "/api/muse/runtime" });
      expect(response.json().locales.response).toEqual(["ko", "en"]);
    } finally {
      if (previousLocales === undefined) {
        delete process.env.MUSE_RESPONSE_LOCALES;
      } else {
        process.env.MUSE_RESPONSE_LOCALES = previousLocales;
      }
    }
  });
});
