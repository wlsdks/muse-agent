/**
 * Muse compat agent-spec helpers extracted from compat-routes.ts.
 *
 * Bridges the @muse/agent-specs registry into the Muse compat shape
 * (parse + validate input, render the API response, build the agent card)
 * for /.well-known/agent-card.json and /api/admin/agent-specs/* routes.
 */

import type { AgentCard, AgentSpec, AgentSpecInput, AgentSpecRegistry } from "@muse/agent-specs";
import { buildAgentCard, type AgentCardToolInput } from "@muse/agent-specs";
import type { JsonObject } from "@muse/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  agentModeResponse,
  errorResponse,
  invalid,
  isRecord,
  parseAgentMode,
  readBodyNullableString,
  readBodyString,
  coerceStringArray,
  type ApiError,
  type ParseResult,
  type CompatibilityRouteOptions
} from "./compat-routes.js";
import { readRouteParam } from "./compat-parsers.js";

export function parseAgentSpecInput(value: unknown, id?: string): ParseResult<AgentSpecInput> {
  if (!isRecord(value)) {
    return invalid("INVALID_AGENT_SPEC", "Body must be an object");
  }

  const name = readBodyString(value, "name") ?? id;
  const mode = parseAgentMode(value.mode);

  if (!name) {
    return invalid("INVALID_AGENT_SPEC", "Body must include a non-empty name");
  }

  if (value.mode !== undefined && !mode) {
    return invalid("INVALID_AGENT_SPEC", `Invalid mode: ${String(value.mode)}`);
  }

  return {
    ok: true,
    value: {
      description: readBodyString(value, "description"),
      enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
      id,
      independentExecution: typeof value.independentExecution === "boolean" ? value.independentExecution : undefined,
      keywords: coerceStringArray(value.keywords),
      mode,
      name,
      systemPrompt: readBodyNullableString(value, "systemPrompt"),
      toolNames: coerceStringArray(value.toolNames)
    }
  };
}

export async function findAgentSpec(registry: AgentSpecRegistry, id: string) {
  return (await registry.getById(id)) ?? (await registry.getByName(id));
}

export async function findAgentSpecOrReply(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CompatibilityRouteOptions
) {
  if (!options.requireAuthenticated(request, reply)) {
    return undefined;
  }
  const id = readRouteParam(request, "id");

  if (!id) {
    return reply.status(400).send(errorResponse("Invalid agent spec id"));
  }

  const spec = await findAgentSpec(options.agentSpecRegistry, id);

  if (!spec) {
    reply.status(404).send(agentSpecNotFound(id));
    return undefined;
  }

  return {
    systemPrompt: spec.systemPrompt ?? null
  };
}

export function agentSpecNotFound(id: string): JsonObject {
  return errorResponse(`에이전트 스펙을 찾을 수 없습니다: ${id}`);
}

export function agentSpecInputError(error: ApiError): JsonObject {
  const invalidMode = error.message.match(/^Invalid mode: (.*)$/u)?.[1];

  return errorResponse(invalidMode ? `유효하지 않은 모드: ${invalidMode}` : "요청 형식이 올바르지 않습니다");
}

export function toAgentSpecUpdateInput(body: Record<string, unknown>, existing: AgentSpec): AgentSpecInput {
  return {
    description: typeof body.description === "string" ? body.description : existing.description,
    enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
    id: existing.id,
    independentExecution: typeof body.independentExecution === "boolean"
      ? body.independentExecution
      : existing.independentExecution,
    keywords: Array.isArray(body.keywords) ? coerceStringArray(body.keywords) : existing.keywords,
    mode: body.mode === undefined ? existing.mode : parseAgentMode(body.mode),
    name: readBodyString(body, "name") ?? existing.name,
    systemPrompt: body.systemPrompt === null ? null : readBodyString(body, "systemPrompt") ?? existing.systemPrompt,
    toolNames: Array.isArray(body.toolNames) ? coerceStringArray(body.toolNames) : existing.toolNames
  };
}

export function toAgentSpecResponse(spec: AgentSpec): JsonObject {
  const prompt = spec.systemPrompt?.trim();
  const preview = prompt
    ? prompt.length <= 120
      ? prompt
      : `${prompt.slice(0, 120)}…`
    : null;

  return {
    createdAt: spec.createdAt.toISOString(),
    description: spec.description,
    enabled: spec.enabled,
    hasSystemPrompt: Boolean(prompt),
    id: spec.id,
    independentExecution: spec.independentExecution,
    keywords: [...spec.keywords],
    mode: agentModeResponse(spec.mode),
    name: spec.name,
    systemPromptPreview: preview,
    toolNames: [...spec.toolNames],
    updatedAt: spec.updatedAt.toISOString()
  };
}

export async function agentCardResponse(options: CompatibilityRouteOptions): Promise<AgentCard> {
  const specs = await options.agentSpecRegistry.listEnabled();
  const tools = options.agentCardToolProvider
    ? await options.agentCardToolProvider()
    : agentCardCapabilitiesFromSpecs(specs);
  const card = buildAgentCard({
    description: options.agentCardIdentity?.description ?? "Muse AI Agent",
    name: options.agentCardIdentity?.name ?? "Muse",
    specs,
    tools,
    version: options.agentCardIdentity?.version ?? "1.0.0"
  });
  return card;
}

function agentCardCapabilitiesFromSpecs(specs: readonly AgentSpec[]): readonly AgentCardToolInput[] {
  const tools = new Map<string, AgentCardToolInput>();
  for (const spec of specs) {
    for (const toolName of spec.toolNames) {
      if (!tools.has(toolName)) {
        tools.set(toolName, {
          description: `Available tool: ${toolName}`,
          inputSchema: null,
          name: toolName
        });
      }
    }
  }
  return [...tools.values()];
}
