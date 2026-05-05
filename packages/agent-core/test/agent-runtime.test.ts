import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "@muse/model";
import { createAgentRuntime, GuardBlockedError } from "../src/index.js";

function createProvider(): ModelProvider {
  return {
    id: "test",
    async generate(request) {
      return {
        id: "response-1",
        model: request.model,
        output: "Muse response"
      };
    },
    async listModels() {
      return [];
    },
    async *stream() {
      yield {
        response: {
          id: "response-1",
          model: "test",
          output: "Muse response"
        },
        type: "done"
      };
    }
  };
}

describe("AgentRuntime", () => {
  it("calls the provider through the model-agnostic interface", async () => {
    const runtime = createAgentRuntime({ modelProvider: createProvider() });

    await expect(
      runtime.run({
        messages: [{ content: "Help me choose", role: "user" }],
        model: "provider/model"
      })
    ).resolves.toMatchObject({
      response: { output: "Muse response" }
    });
  });

  it("blocks when a guard denies the run", async () => {
    const runtime = createAgentRuntime({
      guards: [
        {
          id: "approval",
          evaluate: () => ({ allowed: false, code: "APPROVAL_REQUIRED", reason: "Needs approval" })
        }
      ],
      modelProvider: createProvider()
    });

    await expect(
      runtime.run({
        messages: [{ content: "Run a risky command", role: "user" }],
        model: "provider/model"
      })
    ).rejects.toBeInstanceOf(GuardBlockedError);
  });

  it("fails closed when a guard throws", async () => {
    const runtime = createAgentRuntime({
      guards: [
        {
          id: "broken-guard",
          evaluate: () => {
            throw new Error("policy store unavailable");
          }
        }
      ],
      modelProvider: createProvider()
    });

    await expect(
      runtime.run({
        messages: [{ content: "Hello", role: "user" }],
        model: "provider/model"
      })
    ).rejects.toMatchObject({
      code: "GUARD_ERROR",
      guardId: "broken-guard"
    });
  });

  it("continues when hooks fail", async () => {
    const afterComplete = vi.fn();
    const runtime = createAgentRuntime({
      hooks: [
        {
          id: "broken-hook",
          beforeStart: () => {
            throw new Error("hook failure");
          }
        },
        {
          afterComplete,
          id: "observer"
        }
      ],
      modelProvider: createProvider()
    });

    await runtime.run({
      messages: [{ content: "Hello", role: "user" }],
      model: "provider/model"
    });

    expect(afterComplete).toHaveBeenCalledOnce();
  });
});
