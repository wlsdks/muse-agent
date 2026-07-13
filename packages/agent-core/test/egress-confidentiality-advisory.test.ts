import { describe, expect, it, vi } from "vitest";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { createToolExposureAuthority } from "@muse/policy";
import { createDefaultToolExposurePolicy, ToolRegistry, type MuseTool } from "@muse/tools";

import { createAgentRuntime } from "../src/index.js";
import type { ToolApprovalGateInput } from "../src/agent-runtime-types.js";

/**
 * The CONFIDENTIALITY axis on a NON-URL leaf of an egress-candidate call (S5
 * follow-up, fire-1 redo): the URL rule (egress-authorization.test.ts) only
 * inspects URL leaves, so a private phrase placed in a header VALUE (not the
 * URL itself) is invisible to it. This suite proves the sibling check fires
 * through the SAME `egressAdvisorySink` seam, de-noised to a >=2-token
 * consecutive span (fire-1's rollback reason was a single-shared-word
 * rubber-stamp) — see `sharesPrivateSpan` in actuator-provenance-gate.test.ts
 * for the pure-primitive proof.
 */

function sequenceProvider(responses: readonly ModelResponse[]): ModelProvider {
  let index = 0;
  return {
    id: "test",
    async generate(request: ModelRequest) {
      const response = responses[Math.min(index, responses.length - 1)] ?? responses[responses.length - 1];
      index += 1;
      return { ...response, model: request.model } as ModelResponse;
    },
    async listModels() {
      return [];
    },
    async *stream() {}
  };
}

const authorityFor = (allowedToolNames: readonly string[]) =>
  createToolExposureAuthority({ allowedToolNames, localMode: true });

const alwaysAllowGate = (_input: ToolApprovalGateInput) => ({ allowed: true });

function notesTool(text: string): MuseTool {
  return {
    definition: {
      description: "Search the user's own notes.",
      inputSchema: { properties: { query: { type: "string" } }, required: ["query"], type: "object" },
      name: "muse.notes.search",
      risk: "read"
    },
    execute: () => text
  };
}

function httpTool(name: string): MuseTool {
  return {
    definition: {
      description: `Make an HTTP request (${name}).`,
      inputSchema: {
        properties: {
          headers: { type: "object" },
          url: { type: "string" }
        },
        required: ["url"],
        type: "object"
      },
      name,
      risk: "read"
    },
    execute: () => "ok"
  };
}

function toolTurn(name: string, args: Record<string, unknown>, id = "tc-1", output = "working"): ModelResponse {
  return { id: "t", model: "test-model", output, toolCalls: [{ arguments: args, id, name }] };
}

function finalTurn(output = "Done."): ModelResponse {
  return { id: "final", model: "test-model", output };
}

describe("egress advisory sink — confidentiality axis on non-URL leaves", () => {
  it("a header value carrying a >=2-token private phrase (not typed by the user) fires a confidentiality advisory naming the leaf", async () => {
    const egressAdvisorySink = vi.fn().mockResolvedValue(undefined);
    const runtime = createAgentRuntime({
      maxToolCalls: 6,
      modelProvider: sequenceProvider([
        toolTurn("muse.notes.search", { query: "client" }, "tc-1"),
        toolTurn("http_request", { headers: { "X-Note": "Mallory Kray" }, url: "https://api.example.com/x" }, "tc-2"),
        finalTurn()
      ]),
      toolApprovalGate: alwaysAllowGate,
      toolExposurePolicy: createDefaultToolExposurePolicy({ allowWriteWithoutMutationIntent: true }),
      toolRegistry: new ToolRegistry([
        notesTool("Client: Mallory Kray, invoice #4471 due Friday."),
        httpTool("http_request")
      ]),
      egressAdvisorySink
    });

    await runtime.run({
      messages: [{ content: "Check https://api.example.com/x using my notes.", role: "user" }],
      model: "provider/model",
      runId: "run-confidentiality",
      toolExposureAuthority: authorityFor(["muse.notes.search", "http_request"])
    });

    expect(egressAdvisorySink).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "confidentiality",
        toolName: "http_request"
      })
    );
    const call = egressAdvisorySink.mock.calls.find((args) => args[0].decision === "confidentiality");
    expect(call?.[0].reason).toContain("headers.X-Note");
  });

  it("a header value that is a single common word shared with the notes corpus does NOT fire (de-noise)", async () => {
    const egressAdvisorySink = vi.fn().mockResolvedValue(undefined);
    const runtime = createAgentRuntime({
      maxToolCalls: 6,
      modelProvider: sequenceProvider([
        toolTurn("muse.notes.search", { query: "client" }, "tc-1"),
        toolTurn("http_request", { headers: { "X-Type": "json" }, url: "https://api.example.com/x" }, "tc-2"),
        finalTurn()
      ]),
      toolApprovalGate: alwaysAllowGate,
      toolExposurePolicy: createDefaultToolExposurePolicy({ allowWriteWithoutMutationIntent: true }),
      toolRegistry: new ToolRegistry([
        notesTool("The client prefers a json export of the application data."),
        httpTool("http_request")
      ]),
      egressAdvisorySink
    });

    await runtime.run({
      messages: [{ content: "Check https://api.example.com/x using my notes.", role: "user" }],
      model: "provider/model",
      runId: "run-single-word",
      toolExposureAuthority: authorityFor(["muse.notes.search", "http_request"])
    });

    expect(egressAdvisorySink).not.toHaveBeenCalledWith(expect.objectContaining({ decision: "confidentiality" }));
  });

  it("a clean header with no private span at all does NOT fire", async () => {
    const egressAdvisorySink = vi.fn().mockResolvedValue(undefined);
    const runtime = createAgentRuntime({
      maxToolCalls: 6,
      modelProvider: sequenceProvider([
        toolTurn("muse.notes.search", { query: "client" }, "tc-1"),
        toolTurn("http_request", { headers: { "X-Request-Id": "abc123" }, url: "https://api.example.com/x" }, "tc-2"),
        finalTurn()
      ]),
      toolApprovalGate: alwaysAllowGate,
      toolExposurePolicy: createDefaultToolExposurePolicy({ allowWriteWithoutMutationIntent: true }),
      toolRegistry: new ToolRegistry([
        notesTool("Client: Mallory Kray, invoice #4471 due Friday."),
        httpTool("http_request")
      ]),
      egressAdvisorySink
    });

    await runtime.run({
      messages: [{ content: "Check https://api.example.com/x using my notes.", role: "user" }],
      model: "provider/model",
      runId: "run-clean",
      toolExposureAuthority: authorityFor(["muse.notes.search", "http_request"])
    });

    expect(egressAdvisorySink).not.toHaveBeenCalledWith(expect.objectContaining({ decision: "confidentiality" }));
  });

  it("no regression: a call with no private span still produces byte-identical (no-advisory) URL behavior on an allowed, user-typed URL", async () => {
    const egressAdvisorySink = vi.fn().mockResolvedValue(undefined);
    const runtime = createAgentRuntime({
      maxToolCalls: 4,
      modelProvider: sequenceProvider([
        toolTurn("http_request", { headers: { "X-Request-Id": "abc123" }, url: "https://api.example.com/x" }),
        finalTurn()
      ]),
      toolApprovalGate: alwaysAllowGate,
      toolExposurePolicy: createDefaultToolExposurePolicy({ allowWriteWithoutMutationIntent: true }),
      toolRegistry: new ToolRegistry([httpTool("http_request")]),
      egressAdvisorySink
    });

    await runtime.run({
      messages: [{ content: "Check https://api.example.com/x for me.", role: "user" }],
      model: "provider/model",
      runId: "run-no-signal",
      toolExposureAuthority: authorityFor(["http_request"])
    });

    expect(egressAdvisorySink).not.toHaveBeenCalled();
  });
});
