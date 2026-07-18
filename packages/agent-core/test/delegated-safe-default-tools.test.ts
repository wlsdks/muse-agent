import type { ModelCapabilities, ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { attenuateToolExposureAuthority } from "@muse/policy";
import { ToolRegistry, type MuseTool, type ToolExposurePolicy } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createAgentRuntime } from "../src/index.js";

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

function captureProvider(): { readonly provider: ModelProvider; readonly requests: ModelRequest[] } {
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
  return { provider, requests };
}

const allowlistedCandidatesOnly: ToolExposurePolicy = {
  select(tools, context = {}) {
    const allowed = new Set(context.allowedToolNames ?? []);
    return {
      blocked: [],
      tools: tools.filter((candidate) => allowed.has(candidate.definition.name))
    };
  }
};

describe("delegated safe-default tool ceiling", () => {
  it("exposes only candidate non-local reads through the real AgentRuntime registry", async () => {
    const names = ["remote_read", "remote_write", "shell_execute", "local_read"];
    const authority = attenuateToolExposureAuthority(undefined, names);
    const capture = captureProvider();
    const runtime = createAgentRuntime({
      modelProvider: capture.provider,
      toolExposurePolicy: allowlistedCandidatesOnly,
      toolRegistry: new ToolRegistry([
        tool("remote_read", "read"),
        tool("remote_write", "write"),
        tool("shell_execute", "execute"),
        tool("local_read", "read", true)
      ])
    });

    await runtime.run({
      messages: [{ content: "Use the available tools", role: "user" }],
      model: "test-model",
      runId: "delegated-safe-default",
      toolExposureAuthority: authority
    });

    expect(capture.requests[0]?.tools?.map((candidate) => candidate.name)).toEqual(["remote_read"]);
  });
});
