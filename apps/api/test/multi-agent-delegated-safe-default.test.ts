import { createAgentRuntime } from "@muse/agent-core";
import type { AgentSpec } from "@muse/agent-specs";
import type { ModelCapabilities, ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { MultiAgentOrchestrator } from "@muse/multi-agent";
import { ToolRegistry, type MuseTool, type ToolExposurePolicy } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { buildTieredOrchestration } from "../src/multi-agent-routes.js";

const TOOL_CAPABLE: ModelCapabilities = {
  cost: "unknown",
  latencyProfile: "unknown",
  local: false,
  maxInputTokens: 128000,
  maxOutputTokens: 4096,
  promptCaching: false,
  reasoning: false,
  streaming: true,
  structuredOutput: true,
  toolCalling: true,
  vision: false
};

function tool(name: string, risk: "read" | "write" | "execute", local = false): MuseTool {
  return {
    definition: {
      description: name,
      inputSchema: { type: "object" },
      name,
      risk,
      ...(local ? { scopes: ["local"] as const } : {})
    },
    execute: () => ({ ok: true })
  };
}

const allowlistedCandidatesOnly: ToolExposurePolicy = {
  select(tools, context = {}) {
    const allowed = new Set(context.allowedToolNames ?? []);
    return { blocked: [], tools: tools.filter((candidate) => allowed.has(candidate.definition.name)) };
  }
};

describe("API-shaped delegated safe-default authority", () => {
  it("keeps persisted AgentSpec reads usable without exposing write, execute, or local-read candidates", async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "test",
      async generate(request): Promise<ModelResponse> {
        requests.push(request);
        return { id: "response-1", model: request.model, output: "ok" };
      },
      async listModels() {
        return [{ capabilities: TOOL_CAPABLE, modelId: "test-model", providerId: "test" }];
      },
      async *stream() {
        yield { response: { id: "response-1", model: "test-model", output: "ok" }, type: "done" };
      }
    };
    const runtime = createAgentRuntime({
      modelProvider: provider,
      toolExposurePolicy: allowlistedCandidatesOnly,
      toolRegistry: new ToolRegistry([
        tool("remote_read", "read"),
        tool("remote_write", "write"),
        tool("shell_execute", "execute"),
        tool("local_read", "read", true)
      ])
    });
    const now = new Date(0);
    const spec: AgentSpec = {
      createdAt: now,
      description: "Look up facts safely",
      enabled: true,
      id: "safe-reader",
      independentExecution: false,
      keywords: [],
      mode: "react",
      name: "safe-reader",
      toolNames: ["remote_read", "remote_write", "shell_execute", "local_read"],
      updatedAt: now
    };
    const { workers } = await buildTieredOrchestration(
      [spec],
      runtime,
      { fast: "test-model", heavy: "test-model" },
      () => true
    );

    await new MultiAgentOrchestrator({ workers }).run({
      messages: [{ content: "Use the available tools", role: "user" }],
      model: "test-model",
      runId: "api-shaped-safe-default"
    });

    expect(requests[0]?.tools?.map((candidate) => candidate.name)).toEqual(["remote_read"]);
  });
});
