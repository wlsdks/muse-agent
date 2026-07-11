import { describe, expect, it } from "vitest";
import type { ModelCapabilities, ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { ToolRegistry } from "@muse/tools";
import { createAgentRuntime, ModelToolCallingUnsupportedError } from "../src/index.js";

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

function createCapabilityProvider(options: {
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  readonly id?: string;
  readonly listModelsFails?: boolean;
}): ModelProvider {
  const id = options.id ?? "test";
  return {
    id,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      return {
        id: "response-1",
        model: request.model,
        output: "ok"
      };
    },
    async listModels() {
      if (options.listModelsFails) {
        throw new Error("listModels unavailable");
      }
      return [
        {
          capabilities: options.capabilities,
          modelId: options.modelId,
          providerId: id
        }
      ];
    },
    async *stream() {
      yield {
        response: { id: "response-1", model: options.modelId, output: "ok" },
        type: "done"
      };
    }
  };
}

function createToolRegistry(): ToolRegistry {
  return new ToolRegistry([
    {
      definition: {
        description: "Reads a workspace status.",
        inputSchema: { type: "object" },
        name: "read_status",
        risk: "read"
      },
      execute: () => ({ ok: true })
    }
  ]);
}

describe("model tool-calling capability gate (D5-S3)", () => {
  it("rejects with ModelToolCallingUnsupportedError when toolCalling=false and a tool is exposed", async () => {
    const runtime = createAgentRuntime({
      modelProvider: createCapabilityProvider({
        capabilities: { ...TOOL_CAPABLE, toolCalling: false },
        modelId: "test-model"
      }),
      toolRegistry: createToolRegistry()
    });

    let caught: unknown;
    try {
      await runtime.run({
        messages: [{ content: "Check status", role: "user" }],
        model: "test-model",
        runId: "run-no-tool-calling"
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelToolCallingUnsupportedError);
    expect((caught as ModelToolCallingUnsupportedError).name).toBe("ModelToolCallingUnsupportedError");
    expect((caught as ModelToolCallingUnsupportedError).model).toBe("test-model");
  });

  it("rejects with ModelToolCallingUnsupportedError when structuredOutput=false (toolCalling still true) and a tool is exposed", async () => {
    const runtime = createAgentRuntime({
      modelProvider: createCapabilityProvider({
        capabilities: { ...TOOL_CAPABLE, structuredOutput: false },
        modelId: "test-model"
      }),
      toolRegistry: createToolRegistry()
    });

    let caught: unknown;
    try {
      await runtime.run({
        messages: [{ content: "Check status", role: "user" }],
        model: "test-model",
        runId: "run-no-structured-output"
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelToolCallingUnsupportedError);
    expect((caught as ModelToolCallingUnsupportedError).model).toBe("test-model");
  });

  it("does NOT throw for a tool-capable model (toolCalling+structuredOutput both true) with a tool exposed", async () => {
    const runtime = createAgentRuntime({
      modelProvider: createCapabilityProvider({
        capabilities: TOOL_CAPABLE,
        modelId: "test-model"
      }),
      toolRegistry: createToolRegistry()
    });

    await expect(
      runtime.run({
        messages: [{ content: "Check status", role: "user" }],
        model: "test-model",
        runId: "run-tool-capable"
      })
    ).resolves.toMatchObject({ response: { output: "ok" } });
  });

  it("does NOT throw for a non-tool-calling model when no tools are exposed (no toolRegistry configured)", async () => {
    const runtime = createAgentRuntime({
      modelProvider: createCapabilityProvider({
        capabilities: { ...TOOL_CAPABLE, toolCalling: false },
        modelId: "test-model"
      })
      // no toolRegistry: modelTools() returns [] so the gate never fires.
    });

    await expect(
      runtime.run({
        messages: [{ content: "Just chatting", role: "user" }],
        model: "test-model",
        runId: "run-no-tools-exposed"
      })
    ).resolves.toMatchObject({ response: { output: "ok" } });
  });

  it("does NOT throw for an unknown model (listModels doesn't include the selected modelId) — fails open", async () => {
    const runtime = createAgentRuntime({
      modelProvider: createCapabilityProvider({
        capabilities: { ...TOOL_CAPABLE, toolCalling: false },
        modelId: "some-other-model"
      }),
      toolRegistry: createToolRegistry()
    });

    await expect(
      runtime.run({
        messages: [{ content: "Check status", role: "user" }],
        model: "test-model",
        runId: "run-unknown-model"
      })
    ).resolves.toMatchObject({ response: { output: "ok" } });
  });

  it("does NOT throw when listModels itself fails — fails open on classification failure", async () => {
    const runtime = createAgentRuntime({
      modelProvider: createCapabilityProvider({
        capabilities: { ...TOOL_CAPABLE, toolCalling: false },
        listModelsFails: true,
        modelId: "test-model"
      }),
      toolRegistry: createToolRegistry()
    });

    await expect(
      runtime.run({
        messages: [{ content: "Check status", role: "user" }],
        model: "test-model",
        runId: "run-list-models-fails"
      })
    ).resolves.toMatchObject({ response: { output: "ok" } });
  });
});
