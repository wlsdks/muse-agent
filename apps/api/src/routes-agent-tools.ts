// Agent-spec CRUD/resolve + tool-catalog/loopback/runtime registrars — split out of server-routes.ts (domain cohesion).

import type { AgentSpecResolver } from "@muse/agent-core";
import type { AgentSpecRegistry } from "@muse/agent-specs";
import { describeBuiltinLoopbackMcpServers } from "@muse/domain-tools";
import type { RuntimeSettings } from "@muse/runtime-settings";
import type { FastifyInstance } from "fastify";

import { isRecord, parseAgentSpecInput, parseResponseLocales } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export function registerAgentSpecRoutes(
  server: FastifyInstance,
  agentSpecRegistry: AgentSpecRegistry,
  agentSpecResolver: AgentSpecResolver
): void {
  server.get("/agent-specs", async () => agentSpecRegistry.list());

  server.get("/agent-specs/:name", async (request, reply) => {
    const { name } = request.params as { readonly name: string };
    const spec = await agentSpecRegistry.getByName(name);

    if (!spec) {
      return reply.status(404).send({
        code: "AGENT_SPEC_NOT_FOUND",
        message: `Agent spec not found: ${name}`
      });
    }

    return spec;
  });

  server.post("/agent-specs", async (request, reply) => {
    const parsed = parseAgentSpecInput(request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    const saved = await agentSpecRegistry.save(parsed.value);
    return reply.status(201).send(saved);
  });

  server.delete("/agent-specs/:name", async (request) => {
    const { name } = request.params as { readonly name: string };

    await agentSpecRegistry.deleteByName(name);
    return { deleted: true, name };
  });

  server.post("/agent-specs/resolve", async (request, reply) => {
    const body = request.body;

    if (!isRecord(body) || typeof body.text !== "string") {
      return reply.status(400).send({
        code: "INVALID_AGENT_SPEC_RESOLUTION_REQUEST",
        message: "Body must include a text string"
      });
    }

    const resolution = await agentSpecResolver.resolve(body.text);

    if (!resolution) {
      return { resolution: null };
    }

    return {
      resolution: {
        confidence: resolution.confidence,
        matchedKeywords: resolution.matchedKeywords,
        name: resolution.spec.name,
        toolNames: resolution.spec.toolNames
      }
    };
  });
}

export function registerToolsRoutes(
  server: FastifyInstance,
  options: ServerOptions,
  agentSpecRegistry: AgentSpecRegistry,
  runtimeSettings: RuntimeSettings,
  authService: ServerOptions["authService"]
): void {
  server.get("/api/tools", async (request, reply) => {
    if (!options.toolCatalogProvider) {
      return reply.status(404).send({
        code: "TOOL_CATALOG_UNAVAILABLE",
        message: "Tool catalog provider is not configured"
      });
    }

    const filterRiskRaw = (request.query as { readonly risk?: string } | undefined)?.risk;
    const filterRisk =
      filterRiskRaw === "read" || filterRiskRaw === "write" || filterRiskRaw === "execute"
        ? filterRiskRaw
        : undefined;

    if (filterRiskRaw !== undefined && filterRisk === undefined) {
      return reply.status(400).send({
        code: "INVALID_RISK_FILTER",
        message: "risk must be one of read | write | execute"
      });
    }

    const tools = await options.toolCatalogProvider();
    const filtered = filterRisk ? tools.filter((tool) => tool.risk === filterRisk) : tools;

    return {
      tools: filtered.map((tool) => ({
        description: tool.description,
        name: tool.name,
        risk: tool.risk,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.keywords && tool.keywords.length > 0 ? { keywords: [...tool.keywords] } : {}),
        ...(tool.scopes && tool.scopes.length > 0 ? { scopes: [...tool.scopes] } : {}),
        ...(tool.dependsOn && tool.dependsOn.length > 0 ? { dependsOn: [...tool.dependsOn] } : {})
      })),
      total: filtered.length
    };
  });

  server.get("/api/muse/loopback", async () => {
    const catalog = describeBuiltinLoopbackMcpServers();
    return {
      servers: catalog.map((entry) => ({
        description: entry.description,
        name: entry.name,
        optIn: entry.optIn,
        ...(entry.requires ? { requires: [...entry.requires] } : {}),
        tools: entry.tools.map((tool) => ({
          description: tool.description,
          name: tool.name,
          risk: tool.risk
        })),
        toolCount: entry.tools.length
      })),
      total: catalog.length
    };
  });

  server.get("/api/muse/runtime", async () => {
    const tools = options.toolCatalogProvider ? await options.toolCatalogProvider() : [];
    const toolsByRisk = tools.reduce<Record<"read" | "write" | "execute", number>>(
      (acc, tool) => {
        acc[tool.risk] = (acc[tool.risk] ?? 0) + 1;
        return acc;
      },
      { execute: 0, read: 0, write: 0 }
    );
    const [agentSpecs, settings] = await Promise.all([
      agentSpecRegistry.list(),
      runtimeSettings.list()
    ]);

    return {
      agentCore: { modelAgnostic: true, runner: "rust" },
      agentSpecs: { total: agentSpecs.length },
      capabilities: {
        authEnabled: Boolean(authService),
        historyEnabled: Boolean(options.historyStore),
        mcpEnabled: Boolean(options.mcp),
        modelProviderConfigured: Boolean(options.modelProvider),
        schedulerEnabled: Boolean(options.scheduler)
      },
      defaultModel: options.defaultModel ?? null,
      locales: { response: parseResponseLocales(process.env.MUSE_RESPONSE_LOCALES) },
      service: "muse-api",
      settings: { total: settings.length },
      tools: { byRisk: toolsByRisk, total: tools.length }
    };
  });
}
